import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrainDecision, BrainDriveOpportunityInput } from '../src/brain/types';
import { Logger } from '../src/logger';
import { BotHistory } from '../src/personas/bot-history';
import { generatePersonaV3 } from '../src/personas/generator-v3';
import { PersonaContextBuilder } from '../src/personas/persona-context-builder';
import { PersonaDriveService, PersonaDriveServiceOptions } from '../src/personas/persona-drive.service';
import { PersonaMemory } from '../src/personas/persona-memory';
import { PersonaRuntimeStore } from '../src/personas/persona-runtime-store';
import { MemoryRepository } from '../src/persistence/memory-repository';
import { ReactionBatchResult, ReactionBotCandidate } from '../src/reaction/types';
import { ChatMessage } from '../src/stream-brain/types';
import { ColdStartStatus } from '../src/stream-brain/stream-session';
import { ContextStore } from '../src/stream-brain/context-store';
import { UsageTracker } from '../src/usage/usage-tracker';
import { LearnedPolicyStore } from '../src/learning/learned-policy-store';
import { PersonaMindRecord, PersonaMindStore } from '../src/personas/persona-mind';

afterEach(() => vi.useRealTimers());

async function harness(overrides: Partial<PersonaDriveServiceOptions> = {}) {
  const repository = new MemoryRepository();
  await repository.initialize();
  const usage = new UsageTracker();
  const logger = new Logger('TEST', 'error');
  const contextStore = new ContextStore({ chatWindowMs: 24 * 60 * 60_000, maxChatMessages: 200, maxEvents: 100 });
  contextStore.configure({ channel: 'streamer', category: 'Dota 2', streamContext: '', isLive: true });
  const personaMemory = new PersonaMemory(repository);
  const personaRuntime = new PersonaRuntimeStore();
  const personaContext = new PersonaContextBuilder(personaMemory, personaRuntime);
  const history = new BotHistory(repository, 50);

  const personaA = generatePersonaV3('karlbekner');
  const personaB = generatePersonaV3('gigantiuz');
  const candidatesList: ReactionBotCandidate[] = [
    { username: 'karlbekner', persona: personaA, enabled: true, connectionState: 'CONNECTED', chatConnected: true },
    { username: 'gigantiuz', persona: personaB, enabled: true, connectionState: 'CONNECTED', chatConnected: true },
  ];

  const evaluateOpportunity = vi.fn(async (): Promise<BrainDecision | undefined> => ({ reactions: [], memoryUpdates: [] }));
  const prepareCandidates = vi.fn((usernames: string[]) => `req-${usernames.join(',')}`);
  const submitReaction = vi.fn(async (): Promise<ReactionBatchResult> => ({ eventId: 'x', accepted: [], rejected: [] }));
  const applyMemoryUpdates = vi.fn(async (): Promise<void> => undefined);

  const options: PersonaDriveServiceOptions = {
    enabled: true,
    minIntervalMs: 1_000,
    maxIntervalMs: 1_000,
    minQuietMs: 0,
    globalCooldownMs: 0,
    personaCooldownMs: 0,
    maxCandidates: 3,
    maxBrainCallsPerHour: 100,
    maxMessagesPerHour: 100,
    maxBrainCallProbability: 1,
    candidates: () => candidatesList,
    isStreamLive: () => true,
    isBrainReady: () => true,
    contextStore,
    personaMemory,
    personaRuntime,
    personaContext,
    history,
    evaluateOpportunity,
    prepareCandidates,
    submitReaction,
    applyMemoryUpdates,
    usage,
    logger,
    // Default to always clearing the probability gate (candidates have no recalled memories in
    // most fixtures here, which caps quality-scaled probability well below 1) — tests that
    // specifically exercise weighted candidate selection or the probability gate itself override
    // this per-call.
    random: () => 0,
    ...overrides,
  };
  const service = new PersonaDriveService(options);
  // Return the post-override values actually wired into the service, not the pre-override
  // locals — a test that overrides e.g. submitReaction and then asserts on it must observe
  // the same function instance the service calls.
  return {
    service,
    usage,
    contextStore,
    candidatesList,
    history,
    evaluateOpportunity: options.evaluateOpportunity,
    prepareCandidates: options.prepareCandidates,
    submitReaction: options.submitReaction,
    applyMemoryUpdates: options.applyMemoryUpdates,
  };
}

/** A fixed cold-start reading — these cases are about whether `.active` reaches the payload, not about the window arithmetic, which stream-session.test.ts covers directly. */
function coldStartStatus(active: boolean): ColdStartStatus {
  return { active, ageMs: 0, windowMs: 60_000, hasSentAiMessage: !active, expired: false };
}

function sequence(values: number[]): () => number {
  let index = 0;
  return () => {
    const value = values[Math.min(index, values.length - 1)]!;
    index += 1;
    return value;
  };
}

function chat(kind: ChatMessage['kind'], username: string, timestamp: number, message = 'привет'): ChatMessage {
  return { id: `${username}-${timestamp}`, timestamp, username, displayName: username, message, kind };
}

describe('PersonaDriveService', () => {
  it('has no dependency on GeminiLiveClient or StreamEvent persistence, by construction', async () => {
    const source = await readFile('src/personas/persona-drive.service.ts', 'utf8');
    expect(source).not.toMatch(/GeminiLiveClient|sendAudio|sendVideo|updateContext\(/);
    expect(source).not.toMatch(/eventSink|contextStore\.addEvent|EventDetector/);
  });

  it('makes zero Brain calls while the stream is offline', async () => {
    vi.useFakeTimers();
    const { service, usage, evaluateOpportunity } = await harness({ isStreamLive: () => false });
    service.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(evaluateOpportunity).not.toHaveBeenCalled();
    expect(usage.snapshot().drive).toMatchObject({ ticks: 1, localSkips: 1, brainCalls: 0 });
    service.stop();
  });

  it('makes zero Brain calls while the Brain is not READY', async () => {
    vi.useFakeTimers();
    const { service, evaluateOpportunity } = await harness({ isBrainReady: () => false });
    service.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(evaluateOpportunity).not.toHaveBeenCalled();
    service.stop();
  });

  it('can evaluate an opportunity before any external StreamEvent has ever arrived, once the Brain reports READY', async () => {
    vi.useFakeTimers();
    const { service, evaluateOpportunity } = await harness();
    // notifyExternalEvent() is never called — lastExternalEventAt stays at its start-of-service default.
    service.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(evaluateOpportunity).toHaveBeenCalledTimes(1);
    service.stop();
  });

  it('start() is idempotent — calling it twice does not schedule a second timer', async () => {
    vi.useFakeTimers();
    const { service, usage } = await harness({ isStreamLive: () => false });
    service.start();
    service.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(usage.snapshot().drive.ticks).toBe(1);
    service.stop();
  });

  it('stop() is idempotent and cancels the pending tick', async () => {
    vi.useFakeTimers();
    const { service, usage } = await harness({ isStreamLive: () => false });
    service.start();
    service.stop();
    service.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(usage.snapshot().drive.ticks).toBe(0);
  });

  it('a stop/start reconnect cycle never leaves a duplicate timer running', async () => {
    vi.useFakeTimers();
    const { service, usage } = await harness({ isStreamLive: () => false });
    service.start();
    service.stop();
    service.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(usage.snapshot().drive.ticks).toBe(1);
    service.stop();
  });

  it('uses a jittered interval within [min, max], not a fixed cadence', async () => {
    vi.useFakeTimers();
    const low = await harness({ minIntervalMs: 1_000, maxIntervalMs: 5_000, random: () => 0, isStreamLive: () => false });
    low.service.start();
    await vi.advanceTimersByTimeAsync(999);
    expect(low.usage.snapshot().drive.ticks).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(low.usage.snapshot().drive.ticks).toBe(1);
    low.service.stop();

    const high = await harness({ minIntervalMs: 1_000, maxIntervalMs: 5_000, random: () => 0.9999, isStreamLive: () => false });
    high.service.start();
    await vi.advanceTimersByTimeAsync(4_995);
    expect(high.usage.snapshot().drive.ticks).toBe(0);
    await vi.advanceTimersByTimeAsync(10);
    expect(high.usage.snapshot().drive.ticks).toBe(1);
    high.service.stop();
  });

  it('blocks further attempts once the hourly Brain-call budget is exhausted, without calling Gemini', async () => {
    vi.useFakeTimers();
    const { service, usage, evaluateOpportunity } = await harness({ maxBrainCallsPerHour: 1 });
    service.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(evaluateOpportunity).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(evaluateOpportunity).toHaveBeenCalledTimes(1);
    expect(usage.snapshot().drive.brainCallsBlockedByHourlyLimit).toBe(1);
    service.stop();
  });

  it('blocks further sends once the hourly message budget is exhausted, without calling Gemini', async () => {
    vi.useFakeTimers();
    const { service, usage, evaluateOpportunity, submitReaction } = await harness({
      maxMessagesPerHour: 1,
      globalCooldownMs: 0,
      evaluateOpportunity: vi.fn(async () => ({ reactions: [{ username: 'karlbekner', message: 'привет' }], memoryUpdates: [] })),
      submitReaction: vi.fn(async () => ({ eventId: 'x', accepted: [{ username: 'karlbekner', delayMs: 0 }], rejected: [] })),
    });
    service.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(submitReaction).toHaveBeenCalledTimes(1);
    expect(usage.snapshot().drive.messages).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(evaluateOpportunity).toHaveBeenCalledTimes(1);
    expect(usage.snapshot().drive.messagesBlockedByHourlyLimit).toBe(1);
    service.stop();
  });

  describe('content arbitration for a reaction that finished after a real external event was noted', () => {
    // The old rule was unconditional: any external event noted while Gemini was still generating
    // discarded the result, content unread. A live run showed what that cost — two spontaneous
    // replies thrown away for unrelated 'speech' filler at importance 0.4 and 0.5. Arbitration now
    // reads what was actually recorded since the hook; these pin the service wiring end to end.
    // arbitrateDriveReaction's own outcomes are covered exhaustively in
    // persona-drive-arbitration.test.ts — these three only prove this service calls it and routes
    // each outcome to the right usage counter and submitReaction call.

    it('sends the reaction anyway when a newer event was merely noted but nothing actually conflicts with it', async () => {
      vi.useFakeTimers();
      // A strictly-increasing counter, not the frozen fake Date: notifyExternalEvent() is called
      // from inside evaluateOpportunity(), i.e. at the same virtual instant driveStartedAt was
      // captured at — under a frozen clock both reads would tie, and a real Date.now() in
      // production always ticks forward between them, so this must see "later", not "equal".
      let counter = 1_000_000;
      const now = () => counter++;
      const ref: { service?: PersonaDriveService } = {};
      const { service, usage, submitReaction } = await harness({
        now,
        evaluateOpportunity: vi.fn(async () => {
          ref.service!.notifyExternalEvent();
          return { reactions: [{ username: 'karlbekner', message: 'привет' }], memoryUpdates: [] };
        }),
      });
      ref.service = service;
      service.start();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(submitReaction).toHaveBeenCalledWith(expect.any(String), [{ username: 'karlbekner', message: 'привет' }]);
      expect(usage.snapshot().drive.survivedNewerEvent).toBe(1);
      expect(usage.snapshot().drive.cancelledForExternalEvent).toBe(0);
      service.stop();
    });

    it('sends a reaction built from a five-minute-old observation without expiring it — quiet is not staleness', async () => {
      // The drive is gated on being quiet for at least minQuietMs, not on being fresh, so the subject
      // it fires on is routinely minutes old already by the time generation even starts. Arbitration
      // must measure its TTL from when generation began, never from the subject's own age, or every
      // ordinary drive opportunity on a quiet stream would expire before it was ever sent.
      vi.useFakeTimers();
      const now = Date.now();
      const { service, usage, submitReaction, contextStore } = await harness({
        evaluateOpportunity: vi.fn(async () => ({ reactions: [{ username: 'karlbekner', message: 'привет' }], memoryUpdates: [] })),
      });
      contextStore.addEvent({
        id: 'stale-observation', timestamp: now - 5 * 60_000, type: 'other', summary: 'стример говорит про VPN',
        importance: 0.6, confidence: 0.9, source: 'gemini-live', directMentions: [],
      });
      service.start();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(submitReaction).toHaveBeenCalledWith(expect.any(String), [{ username: 'karlbekner', message: 'привет' }]);
      expect(usage.snapshot().drive.droppedExpired).toBe(0);
      expect(usage.snapshot().drive.cancelledForExternalEvent).toBe(0);
      service.stop();
    });

    it('discards the reaction when a viewer already said essentially the same thing while Gemini was thinking', async () => {
      vi.useFakeTimers();
      const { service, usage, submitReaction, contextStore } = await harness({
        evaluateOpportunity: vi.fn(async () => {
          // A real tick between the hook and this chat message, so it reads as "after" — under a
          // frozen fake clock a same-instant write would tie the hook and never count as newer.
          vi.setSystemTime(Date.now() + 1);
          contextStore.addChat(chat('viewer', 'realviewer', Date.now(), 'го дальше по классике'));
          return { reactions: [{ username: 'karlbekner', message: 'го дальше по классике' }], memoryUpdates: [] };
        }),
      });
      service.start();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(submitReaction).toHaveBeenCalledWith(expect.any(String), []);
      expect(usage.snapshot().drive.droppedDuplicate).toBe(1);
      expect(usage.snapshot().drive.cancelledForExternalEvent).toBe(1);
      service.stop();
    });

    it('discards the reaction when an unrelated, high-importance event lands elsewhere while Gemini was thinking', async () => {
      vi.useFakeTimers();
      const { service, usage, submitReaction, contextStore } = await harness({
        evaluateOpportunity: vi.fn(async () => {
          vi.setSystemTime(Date.now() + 1);
          contextStore.addEvent({
            id: 'superseding', timestamp: Date.now(), type: 'mishap',
            summary: 'стример роняет кружку с чаем на клавиатуру и вскакивает',
            importance: 0.9, confidence: 0.9, source: 'gemini-live', directMentions: [],
          });
          return { reactions: [{ username: 'karlbekner', message: 'го дальше по классике' }], memoryUpdates: [] };
        }),
      });
      service.start();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(submitReaction).toHaveBeenCalledWith(expect.any(String), []);
      expect(usage.snapshot().drive.droppedSuperseded).toBe(1);
      service.stop();
    });
  });

  it('keeps durable memory from a tick that ends in silence, since remembering is not speaking', async () => {
    // Every decision may carry memory proposals, and the ones from spontaneous initiation were
    // parsed and then dropped: the tick returned before anything looked at them.
    vi.useFakeTimers();
    const decision: BrainDecision = {
      reactions: [],
      memoryUpdates: [{
        scope: 'global', type: 'preference', summary: 'Стример не ест жареную картошку.',
        importance: 0.6, confidence: 0.8,
      }],
    };
    const { service, applyMemoryUpdates, submitReaction } = await harness({
      evaluateOpportunity: vi.fn(async () => decision),
    });
    service.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(applyMemoryUpdates).toHaveBeenCalledWith(decision, expect.any(String));
    expect(submitReaction).toHaveBeenCalledWith(expect.any(String), []);
    service.stop();
  });

  it('treats an empty reaction list as silence, a fully valid and common outcome', async () => {
    vi.useFakeTimers();
    const { service, usage, submitReaction } = await harness();
    service.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(submitReaction).toHaveBeenCalledWith(expect.any(String), []);
    expect(usage.snapshot().drive.silentDecisions).toBe(1);
    service.stop();
  });

  describe('the AI feedback-loop chain-depth gate', () => {
    // ContextStore.addChat() prunes anything older than chatWindowMs against its own now(), which
    // defaults to Date.now() same as fake-timer Date — timestamps must stay relative to that, not
    // small fixed constants, or they get pruned before aiChainDepth() ever sees them.
    it('a single trailing AI message does not block a drive attempt (A → B is allowed)', async () => {
      vi.useFakeTimers();
      const now = Date.now();
      const { service, contextStore, evaluateOpportunity } = await harness();
      contextStore.addChat(chat('bot', 'karlbekner', now - 1_000));
      service.start();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(evaluateOpportunity).toHaveBeenCalledTimes(1);
      service.stop();
    });

    it('tells the Brain how old the newest observation is, so it can drop a topic the stream has left', async () => {
      // A connected perception layer that reports nothing looks exactly like a quiet stream from
      // here. Production spent 5.8 minutes in that state and every spontaneous message in the
      // window was written against the same frozen observation.
      vi.useFakeTimers();
      const now = Date.now();
      const { service, contextStore, evaluateOpportunity } = await harness();
      contextStore.addEvent({
        id: 'event-1', timestamp: now - 300_000, type: 'other', summary: 'Стример говорит про VPN.',
        importance: 0.6, confidence: 0.9, source: 'gemini-live', category: 'IRL', directMentions: [],
      });
      service.start();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(evaluateOpportunity).toHaveBeenCalledTimes(1);
      expect(evaluateOpportunity.mock.calls[0]?.[0]?.secondsSinceLastObservation).toBe(301);
      service.stop();
    });

    it('shows the Brain what the session just heard and saw, not only how long ago', async () => {
      // Six drive calls produced nothing on a live run, and this is why: the payload carried the
      // chat (nearly empty on an IRL stream), each account's own last messages, memories from other
      // evenings, and the age of the newest observation — never its content. The instruction asks
      // for a thought about what is happening; what was happening was not in the request. Twelve
      // seconds after the stream explained a webcam plan a drive call came back silent while the
      // event path, handed the same words, wrote "с камерой норм задумка, живее будет".
      vi.useFakeTimers();
      const now = Date.now();
      const { service, contextStore, evaluateOpportunity } = await harness();
      contextStore.addSpeech('S: вебку вот так делать, чтобы IRL был', now - 12_000);
      contextStore.addSpeech('O: наверно Сларк умер', now - 6_000);
      contextStore.addEvent({
        id: 'event-1', timestamp: now - 6_000, type: 'conversation',
        summary: 'S: вебку вот так делать, чтобы IRL был',
        importance: 0.5, confidence: 0.9, source: 'transcription', directMentions: [],
      });
      service.start();
      await vi.advanceTimersByTimeAsync(1_000);

      const input = evaluateOpportunity.mock.calls[0]?.[0];
      expect(input?.recentSpeech?.map((line) => line.text)).toEqual([
        'S: вебку вот так делать, чтобы IRL был',
        'O: наверно Сларк умер',
      ]);
      expect(input?.recentEvents?.map((item) => item.summary)).toEqual([
        'S: вебку вот так делать, чтобы IRL был',
      ]);
      // Still told the age, so a stale subject is still droppable. Six seconds old when seeded, plus
      // the one second the scheduler waits before the tick.
      expect(input?.secondsSinceLastObservation).toBe(7);
      service.stop();
    });

    it('carries the first-message condition when nothing has been said this session', async () => {
      // A spontaneous aside is a worse first impression than a reaction to something on screen, so
      // the drive is held to the same condition rather than slipping under it.
      vi.useFakeTimers();
      const cold = await harness({ coldStart: () => coldStartStatus(true) });
      cold.service.start();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(cold.evaluateOpportunity.mock.calls[0]?.[0]?.firstMessageGate)
        .toContain('Nothing has been sent this session yet');
      cold.service.stop();

      const warm = await harness({ coldStart: () => coldStartStatus(false) });
      warm.service.start();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(warm.evaluateOpportunity.mock.calls[0]?.[0]).not.toHaveProperty('firstMessageGate');
      warm.service.stop();
    });

    it('omits the hooks entirely when the session has observed nothing yet', async () => {
      // Absent rather than empty: a drive opportunity with nothing behind it should look like one.
      vi.useFakeTimers();
      const { service, evaluateOpportunity } = await harness();
      service.start();
      await vi.advanceTimersByTimeAsync(1_000);
      const input = evaluateOpportunity.mock.calls[0]?.[0];
      expect(input).not.toHaveProperty('recentSpeech');
      expect(input).not.toHaveProperty('recentEvents');
      service.stop();
    });

    it('two consecutive trailing AI messages block a drive attempt (A → B → C is blocked)', async () => {
      vi.useFakeTimers();
      const now = Date.now();
      const { service, contextStore, usage, evaluateOpportunity } = await harness();
      contextStore.addChat(chat('bot', 'karlbekner', now - 2_000));
      contextStore.addChat(chat('bot', 'gigantiuz', now - 1_000));
      service.start();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(evaluateOpportunity).not.toHaveBeenCalled();
      expect(usage.snapshot().drive.cancelledForCooldown).toBe(1);
      service.stop();
    });

    it('does not count several accounts answering one stream event as a chain', async () => {
      vi.useFakeTimers();
      const now = Date.now();
      const { service, contextStore, history, evaluateOpportunity } = await harness();
      // Three accounts replying to the same observed moment are parallel reactions to something
      // that happened on stream, not bots talking to each other. Counted as a chain, a single
      // event routinely closed this gate for good, since one event draws up to three replies.
      await history.add('karlbekner', 'привет', 'event-42', now - 3_000);
      await history.add('gigantiuz', 'привет', 'event-42', now - 2_000);
      contextStore.addChat(chat('bot', 'karlbekner', now - 3_000));
      contextStore.addChat(chat('bot', 'gigantiuz', now - 2_000));
      service.start();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(evaluateOpportunity).toHaveBeenCalledTimes(1);
      service.stop();
    });

    it('still blocks when the trailing messages were autonomous rather than answers to the stream', async () => {
      vi.useFakeTimers();
      const now = Date.now();
      const { service, contextStore, history, usage, evaluateOpportunity } = await harness();
      await history.add('karlbekner', 'привет', 'persona-drive:abc', now - 3_000);
      await history.add('gigantiuz', 'привет', 'persona-drive:def', now - 2_000);
      contextStore.addChat(chat('bot', 'karlbekner', now - 3_000));
      contextStore.addChat(chat('bot', 'gigantiuz', now - 2_000));
      service.start();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(evaluateOpportunity).not.toHaveBeenCalled();
      expect(usage.snapshot().drive.cancelledForCooldown).toBe(1);
      service.stop();
    });

    it('a real human message resets the chain', async () => {
      vi.useFakeTimers();
      const now = Date.now();
      const { service, contextStore, evaluateOpportunity } = await harness();
      contextStore.addChat(chat('bot', 'karlbekner', now - 3_000));
      contextStore.addChat(chat('bot', 'gigantiuz', now - 2_000));
      contextStore.addChat(chat('viewer', 'realviewer', now - 1_000));
      service.start();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(evaluateOpportunity).toHaveBeenCalledTimes(1);
      service.stop();
    });
  });

  describe('candidate selection', () => {
    it('never sends more candidates than maxCandidates', async () => {
      vi.useFakeTimers();
      const personaC = generatePersonaV3('supercser2');
      const { service, candidatesList, prepareCandidates } = await harness({ maxCandidates: 2 });
      candidatesList.push({ username: 'supercser2', persona: personaC, enabled: true, connectionState: 'CONNECTED', chatConnected: true });
      service.start();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(prepareCandidates).toHaveBeenCalledTimes(1);
      expect(prepareCandidates.mock.calls[0]![0]).toHaveLength(2);
      service.stop();
    });

    it('excludes disabled and disconnected bots', async () => {
      vi.useFakeTimers();
      const { service, candidatesList, evaluateOpportunity } = await harness();
      candidatesList[0]!.enabled = false;
      candidatesList[1]!.connectionState = 'DISCONNECTED';
      service.start();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(evaluateOpportunity).not.toHaveBeenCalled();
      service.stop();
    });

    it('excludes a persona still inside its own cooldown window', async () => {
      vi.useFakeTimers();
      const { service, candidatesList, prepareCandidates } = await harness({
        maxCandidates: 1, personaCooldownMs: 10 * 60_000,
        evaluateOpportunity: vi.fn(async () => ({ reactions: [{ username: 'karlbekner', message: 'привет' }], memoryUpdates: [] })),
        submitReaction: vi.fn(async () => ({ eventId: 'x', accepted: [{ username: 'karlbekner', delayMs: 0 }], rejected: [] })),
      });
      candidatesList.length = 1; // only karlbekner, so a cooldown on it means zero candidates next tick
      service.start();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(prepareCandidates).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(prepareCandidates).toHaveBeenCalledTimes(1); // still 1 — karlbekner is on its own cooldown now
      service.stop();
    });

    it('picks a high chatFrequency persona far more often than a very-low one (seeded random)', async () => {
      const personaHigh = generatePersonaV3('alexmadkid');
      personaHigh.behavior.activity.chatFrequency = 'high';
      personaHigh.behavior.reactionProbability = 0.5;
      const personaLow = generatePersonaV3('darwinboo2');
      personaLow.behavior.activity.chatFrequency = 'very-low';
      personaLow.behavior.reactionProbability = 0.5;
      const candidatesList: ReactionBotCandidate[] = [
        { username: 'alexmadkid', persona: personaHigh, enabled: true, connectionState: 'CONNECTED', chatConnected: true },
        { username: 'darwinboo2', persona: personaLow, enabled: true, connectionState: 'CONNECTED', chatConnected: true },
      ];
      // weight ratio is ~13:1 in favor of 'high'; only random() > ~0.93 should ever pick 'low' first.
      // random() is also used for scheduleNext()'s jitter (consumed once by start(), value irrelevant
      // since minIntervalMs === maxIntervalMs here) before it's used for weighted candidate selection,
      // then again for the probability gate — feed a 3-value sequence: [jitter, selection, probability].
      vi.useFakeTimers();
      const mid = await harness({ maxCandidates: 1, candidates: () => candidatesList, random: sequence([0, 0.5, 0]) });
      mid.service.start();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(mid.prepareCandidates.mock.calls[0]![0]).toEqual(['alexmadkid']);
      mid.service.stop();

      const extreme = await harness({ maxCandidates: 1, candidates: () => candidatesList, random: sequence([0, 0.97, 0]) });
      extreme.service.start();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(extreme.prepareCandidates.mock.calls[0]![0]).toEqual(['darwinboo2']);
      extreme.service.stop();
    });
  });

  describe('fixture L — Persona Drive no longer bypasses the operator', () => {
    const NOW = 1_700_000_000_000;

    function mindFor(username: string, carrying: boolean): PersonaMindRecord {
      return {
        personaId: `account-${username}`, username, seedVersion: 1,
        knowledge: [], openLoops: [], people: [], life: [],
        curiosities: carrying
          ? [{ id: 'c1', topic: 'аренда жилья', question: 'сколько стоит аренда в Шанхае', status: 'open', strength: 0.9, createdAt: NOW, updatedAt: NOW }]
          : [],
        moment: { mood: 'спокойное настроение', energy: 0.7, attention: 'watching', updatedAt: NOW },
        createdAt: NOW, updatedAt: NOW,
      };
    }

    async function learnedPolicyWith(rule: string): Promise<LearnedPolicyStore> {
      const repository = new MemoryRepository();
      await repository.initialize();
      await repository.applyLearnedPolicyBatch({
        upserts: [{
          id: 'rule-laughter', scopeType: 'global', scopeKey: '', rule, rationale: 'operator feedback',
          confidence: 0.9, supportCount: 3, positiveEvidence: 0, negativeEvidence: 3, status: 'active',
          teacherModel: 'test', evidenceIds: [], createdAt: NOW, updatedAt: NOW, version: 1,
        }],
        processedVerdictIds: [], processedAt: NOW,
      });
      const store = new LearnedPolicyStore(repository, new Logger('TEST', 'error'));
      await store.load();
      return store;
    }

    async function mindStoreWith(minds: PersonaMindRecord[]): Promise<PersonaMindStore> {
      const repository = new MemoryRepository();
      await repository.initialize();
      for (const record of minds) await repository.savePersonaMind(record);
      const store = new PersonaMindStore(repository, new Logger('TEST', 'error'), () => NOW);
      await store.load();
      return store;
    }

    it('supplies active learned rules to a drive decision — the confirmed production bypass', async () => {
      vi.useFakeTimers();
      const learnedPolicy = await learnedPolicyWith('Do not open commentary with formulaic laughter.');
      const mind = await mindStoreWith([mindFor('karlbekner', true), mindFor('gigantiuz', true)]);
      const { service, evaluateOpportunity } = await harness({ learnedPolicy, mind });
      service.start();
      await vi.advanceTimersByTimeAsync(1_000);
      const input = evaluateOpportunity.mock.calls[0]?.[0];
      expect(input?.learnedPolicy?.global).toEqual(['Do not open commentary with formulaic laughter.']);
      expect(input?.mindContext?.byPersona).toBeDefined();
      service.stop();
    });

    it('skips the model call entirely when no candidate carries any thought of their own', async () => {
      vi.useFakeTimers();
      const mind = await mindStoreWith([mindFor('karlbekner', false), mindFor('gigantiuz', false)]);
      const { service, usage, evaluateOpportunity } = await harness({ mind });
      service.start();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(evaluateOpportunity).not.toHaveBeenCalled();
      expect(usage.snapshot().drive.localSkips).toBe(1);
      service.stop();
    });

    it('keeps the old behavior when no mind store is wired at all', async () => {
      vi.useFakeTimers();
      const { service, evaluateOpportunity } = await harness();
      service.start();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(evaluateOpportunity).toHaveBeenCalledTimes(1);
      service.stop();
    });

    it('passes the drive reaction motive through to the coordinator batch', async () => {
      vi.useFakeTimers();
      const mind = await mindStoreWith([mindFor('karlbekner', true), mindFor('gigantiuz', true)]);
      const { service, submitReaction } = await harness({
        mind,
        evaluateOpportunity: vi.fn(async () => ({
          reactions: [{
            username: 'karlbekner', message: 'кстати а сколько там аренда выходит',
            motive: 'ask', sourceType: 'curiosity', sourceRef: 'аренда жилья',
          }],
          memoryUpdates: [],
        })),
      });
      service.start();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(submitReaction).toHaveBeenCalledWith(expect.any(String), [expect.objectContaining({
        username: 'karlbekner', motive: 'ask', sourceType: 'curiosity', sourceRef: 'аренда жилья',
      })]);
      service.stop();
    });
  });

  it('builds a per-candidate input of changed state only — no persona profile, which the bootstrap already put in the same interaction chain', async () => {
    vi.useFakeTimers();
    let seen: BrainDriveOpportunityInput | undefined;
    const { service } = await harness({
      maxCandidates: 1,
      evaluateOpportunity: vi.fn(async (input: BrainDriveOpportunityInput) => { seen = input; return { reactions: [], memoryUpdates: [] }; }),
    });
    service.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(seen?.triggerKind).toBe('persona_drive');
    expect(seen?.candidates).toHaveLength(1);
    const candidate = seen!.candidates[0]!;
    expect(candidate).toMatchObject({
      username: expect.any(String),
      mood: expect.any(String),
      engagement: expect.any(Number),
      recalledMemories: expect.any(Array),
      recentOwnMessages: expect.any(Array),
    });
    // The profile is deliberately absent: resending it per candidate per drive call duplicated
    // context the bootstrap already established in this same previous_interaction_id chain.
    expect(candidate).not.toHaveProperty('profile');
    expect(JSON.stringify(seen)).not.toContain('speechFingerprint');
    service.stop();
  });
});
