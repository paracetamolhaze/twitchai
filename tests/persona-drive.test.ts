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
import { ContextStore } from '../src/stream-brain/context-store';
import { UsageTracker } from '../src/usage/usage-tracker';

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
  };
}

function sequence(values: number[]): () => number {
  let index = 0;
  return () => {
    const value = values[Math.min(index, values.length - 1)]!;
    index += 1;
    return value;
  };
}

function chat(kind: ChatMessage['kind'], username: string, timestamp: number): ChatMessage {
  return { id: `${username}-${timestamp}`, timestamp, username, displayName: username, message: 'привет', kind };
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

  it('discards a decision that resolves after a real external event arrived while Gemini was thinking', async () => {
    vi.useFakeTimers();
    // A strictly-increasing counter, not the frozen fake Date: notifyExternalEvent() is called
    // from inside evaluateOpportunity(), i.e. at the same virtual instant driveStartedAt was
    // captured at — under a frozen clock both reads would tie, and a real Date.now() in
    // production always ticks forward between them, so the discard check must see "later", not "equal".
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
    expect(submitReaction).toHaveBeenCalledWith(expect.any(String), []);
    expect(usage.snapshot().drive.cancelledForExternalEvent).toBe(1);
    expect(usage.snapshot().drive.messages).toBe(0);
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
