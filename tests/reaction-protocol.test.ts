import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReactionMemory } from '../src/learning/reaction-memory';
import { GlobalStreamerMemory } from '../src/global-memory/global-streamer-memory';
import { Logger } from '../src/logger';
import { BotHistory } from '../src/personas/bot-history';
import { PersonaContextBuilder } from '../src/personas/persona-context-builder';
import { PersonaMemory } from '../src/personas/persona-memory';
import { PersonaRuntimeStore } from '../src/personas/persona-runtime-store';
import { generatePersonaV3 } from '../src/personas/generator-v3';
import { PersonaFeedbackStore } from '../src/personas/feedback-store';
import { LearnedPolicyStore } from '../src/learning/learned-policy-store';
import { LearnedPolicyRule } from '../src/learning/learned-policy.types';
import { MemoryRepository } from '../src/persistence/memory-repository';
import { SHORTLIST_TARGET_SIZE } from '../src/reaction/candidate-shortlist';
import { NaturalnessGuard } from '../src/reaction/naturalness-guard';
import { ReactionCoordinator } from '../src/reaction/reaction-coordinator';
import { ReactionPolicyGuard } from '../src/reaction/reaction-policy-guard';
import { ReactionBotCandidate, ReactionTraceRecord } from '../src/reaction/types';
import { ContextStore } from '../src/stream-brain/context-store';
import { ColdStartStatus, StreamSession } from '../src/stream-brain/stream-session';
import { StreamEvent } from '../src/stream-brain/types';
import { UsageTracker } from '../src/usage/usage-tracker';

const event: StreamEvent = {
  id: 'event-1', timestamp: 1_700_000_000_000, type: 'fail',
  summary: 'стример промахнулся решающим ультимейтом', importance: 0.92,
  confidence: 0.96, source: 'gemini-live', directMentions: [],
};
const CANDIDATE_PERSONAS = ['gigantiuz', 'supercser2', '404notf0und404', 'novostro1ka']
  .map((username) => generatePersonaV3(username));

function bot(username: string, index: number): ReactionBotCandidate {
  return {
    username,
    persona: {
      ...CANDIDATE_PERSONAS[index]!,
      behavior: { ...CANDIDATE_PERSONAS[index]!.behavior, minimumIntervalMs: 30_000 },
    },
    enabled: true,
    connectionState: 'CONNECTED',
    chatConnected: true,
  };
}

type SenderResult = boolean | ((username: string, message: string) => boolean | Promise<boolean>);

async function setup(
  senderResult: SenderResult = true,
  now: () => number = () => event.timestamp,
  captureLogs = false,
  feedbackStore?: PersonaFeedbackStore,
  learnedPolicy?: LearnedPolicyStore,
) {
  const sendResult = senderResult;
  // Most cases here silence the logger; the ones asserting on what a decision records need to read
  // it, and the log line is the only place the addressee and grounding classification appear.
  const written: Array<Record<string, unknown>> = [];
  if (captureLogs) {
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      if (typeof line === 'string') {
        try { written.push(JSON.parse(line) as Record<string, unknown>); } catch { /* not ours */ }
      }
    });
  }
  const repository = new MemoryRepository();
  await repository.initialize();
  const history = new BotHistory(repository);
  const personaMemory = new PersonaMemory(repository, { now });
  const personaRuntime = new PersonaRuntimeStore(now);
  const contextStore = new ContextStore({ chatWindowMs: 120_000, maxChatMessages: 100, maxEvents: 100, now });
  contextStore.configure({ channel: 'streamer', category: 'Dota 2', streamContext: 'рейтинг с друзьями' });
  contextStore.addChat({
    id: 'chat-1', timestamp: event.timestamp, username: 'viewer', displayName: 'Viewer',
    message: '@bot-two ну что скажешь?', kind: 'viewer',
  });
  let candidates = [bot('bot-one', 0), bot('bot-two', 1), bot('bot-three', 2)];
  // Off by default: delivery can only be judged while an account is reading chat, and most tests
  // here have no reader, so arming the watchdog would report every message as undelivered.
  let observesChat = false;
  // The logical-session state the coordinator consults, faked here so the payload and the send path
  // can be tested without standing up an Application. A plain boolean toggle rather than a real
  // StreamSession: these cases are about what the coordinator does with the status, not about the
  // window/continuity arithmetic itself, which stream-session.test.ts already covers directly.
  let coldStartActive = false;
  const coldStart = (): ColdStartStatus => ({
    active: coldStartActive, ageMs: 0, windowMs: 60_000, hasSentAiMessage: false, expired: false,
  });
  let messageSentCalls = 0;
  const sent: Array<{ username: string; message: string }> = [];
  const usage = new UsageTracker();
  const globalMemory = new GlobalStreamerMemory({ repository, usage, now });
  await globalMemory.startOrResumeSession({ channel: 'streamer', initialCategory: 'Dota 2' });
  const policy = new ReactionPolicyGuard({
    globalMessagesPer30Seconds: 2,
    maxReactionsPerEvent: 3,
    // These cases are about staggering, deduplication and terminal state, not about how many
    // accounts a crowd of three is allowed; the share itself has its own test.
    reactionShareOfCandidates: 1,
    now,
  });
  const coordinator = new ReactionCoordinator({
    policy,
    naturalness: new NaturalnessGuard(),
    ...(feedbackStore ? { feedbackStore } : {}),
    ...(learnedPolicy ? { learnedPolicy } : {}),
    coldStart,
    onMessageSent: () => { messageSentCalls += 1; },
    sender: {
      send: async (username, message) => {
        sent.push({ username, message });
        const accepted = await (typeof sendResult === 'function' ? sendResult(username, message) : sendResult);
        return accepted
          ? { submitted: true, submittedAt: now() }
          : { submitted: false, reason: 'twitch_send_failed' };
      },
    },
    history,
    memory: new ReactionMemory({ enabled: true, reactionWindowMs: 1_000, repository }),
    globalMemory,
    personaContext: new PersonaContextBuilder(personaMemory, personaRuntime),
    personaMemory,
    personaRuntime,
    contextStore,
    usage,
    logger: new Logger('TEST', captureLogs ? 'info' : 'error'),
    retrievalLimit: 4,
    candidates: () => candidates,
    contextTtlMs: 60_000,
    observesChat: () => observesChat,
    deliveryEchoTimeoutMs: 10_000,
    now,
  });
  return {
    coordinator, globalMemory, history, policy, sent, usage, personaMemory,
    logged: () => written,
    setColdStart: (value: boolean) => { coldStartActive = value; },
    messageSentCalls: () => messageSentCalls,
    candidatesFor: (username: string) => candidates.find((candidate) => candidate.username === username)!,
    setCandidates: (value: ReactionBotCandidate[]) => { candidates = value; },
    setObservesChat: (value: boolean) => { observesChat = value; },
    contextStore,
  };
}

afterEach(() => vi.useRealTimers());

describe('single-session reaction protocol', () => {
  it('keeps ordinary Brain turns small and does not resend global memory or persona profiles', async () => {
    const { coordinator, globalMemory } = await setup();
    await globalMemory.recordFromBrain({
      memories: [{
        type: 'important_event', summary: 'Стример промахнулся решающим ультимейтом.',
        entities: ['ультимейт'], tags: ['Dota 2'], importance: .9, confidence: .95,
      }],
    });

    const prepared = await coordinator.prepareBrainEvent(event, 0);

    expect(prepared.availableBots).toEqual(['bot-one', 'bot-two', 'bot-three']);
    expect(prepared.targetedPersonaContext).toEqual([]);
    expect(prepared.reactionExamples.length).toBeLessThanOrEqual(3);
    expect(prepared).not.toHaveProperty('personas');
    expect(prepared).not.toHaveProperty('globalStreamerMemories');
    // Small still means small: full profiles and the whole memory store stay out. What does travel
    // is a handful of streamer facts matched against what was just said — memory is where opinions
    // live, and an ordinary moment used to be answered with none of it in front of the model.
    expect(prepared.streamerMemories?.length ?? 0).toBeLessThanOrEqual(3);
    expect(prepared.streamerMemories).toEqual([
      expect.objectContaining({ summary: 'Стример промахнулся решающим ультимейтом.' }),
    ]);
    await coordinator.stop();
  });

  it('deterministically skips all generated replies to a direct account-classification question', async () => {
    vi.useFakeTimers();
    const { coordinator, sent } = await setup();
    const classificationEvent: StreamEvent = {
      ...event,
      id: 'account-classification-event',
      type: 'conversation',
      summary: 'viewer directly addressed @bot-one: @bot-one ты бот?',
      speech: '@bot-one ты бот?',
      directMentions: ['bot-one'],
      viewerUsername: 'viewer',
    };

    for (const [index, message] of ['палево', 'да', 'нет, я человек', 'я Gemini'].entries()) {
      const classifiedEvent = { ...classificationEvent, id: `${classificationEvent.id}-${index}` };
      const prepared = await coordinator.prepareBrainEvent(classifiedEvent, 0);
      expect(prepared.availableBots).toEqual(['bot-one']);
      const result = await coordinator.submitBatch({
        eventId: classifiedEvent.id,
        reactions: [{ username: 'bot-one', message }],
      });

      expect(result.accepted).toEqual([]);
      expect(result.rejected).toEqual([
        { username: 'bot-one', reason: 'account_classification' },
      ]);
    }
    await vi.runAllTimersAsync();
    expect(sent).toEqual([]);
    await coordinator.stop();
  });

  it('rejects internal implementation leaks without blocking an ordinary external AI topic', async () => {
    vi.useFakeTimers();
    const { coordinator, sent } = await setup();
    const leakEvent = { ...event, id: 'internal-leak-event' };
    await coordinator.prepareBrainEvent(leakEvent, 0);
    const leak = await coordinator.submitBatch({
      eventId: leakEvent.id,
      reactions: [{ username: 'bot-one', message: 'я Gemini personaId=account-bot-one' }],
    });

    expect(leak.accepted).toEqual([]);
    expect(leak.rejected).toEqual(expect.arrayContaining([
      expect.objectContaining({ username: 'bot-one', reason: 'internal_metadata' }),
    ]));
    await vi.runAllTimersAsync();
    expect(sent).toEqual([]);

    const externalAiEvent: StreamEvent = {
      ...event,
      id: 'external-ai-topic-event',
      type: 'conversation',
      summary: 'viewer directly addressed @bot-one: ты пробовал Gemini для кода?',
      speech: '@bot-one ты пробовал Gemini для кода?',
      directMentions: ['bot-one'],
      viewerUsername: 'viewer',
    };
    await coordinator.prepareBrainEvent(externalAiEvent, 0);
    const externalTopic = await coordinator.submitBatch({
      eventId: externalAiEvent.id,
      reactions: [{ username: 'bot-one', message: 'Gemini для кода иногда норм' }],
    });

    expect(externalTopic.rejected).toEqual([]);
    expect(externalTopic.accepted).toHaveLength(1);
    await vi.runAllTimersAsync();
    expect(sent).toEqual([{ username: 'bot-one', message: 'Gemini для кода иногда норм' }]);
    await coordinator.stop();
  });

  it('rejects self-disclosure as an artificial viewer, including close forms', async () => {
    const { coordinator, sent } = await setup();
    const disclosures = [
      'я искусственный зритель', 'я являюсь синтетическим зрителем', 'я ИИ', 'я Gemini',
      'я программа', 'я алгоритм', 'я человек', 'я настоящий человек', 'я реальный человек',
      'какая модель меня генерирует',
    ];

    for (const [index, message] of disclosures.entries()) {
      const disclosureEvent = { ...event, id: `artificial-viewer-${index}` };
    await coordinator.prepareBrainEvent(disclosureEvent, 0);
      const result = await coordinator.submitBatch({
        eventId: disclosureEvent.id,
        reactions: [{ username: 'bot-one', message }],
      });

      expect(result.accepted).toEqual([]);
      expect(result.rejected).toEqual(expect.arrayContaining([
        expect.objectContaining({ username: 'bot-one', reason: 'internal_metadata' }),
      ]));
    }

    expect(sent).toEqual([]);
    await coordinator.stop();
  });

  it('rejects Russian operational leaks with inflected words', async () => {
    const { coordinator, sent } = await setup();
    const messages = [
      'системный промпт велел это написать',
      'это сгенерированный профиль',
    ];

    for (const [index, message] of messages.entries()) {
      const internalEvent = { ...event, id: `russian-internal-leak-${index}` };
    await coordinator.prepareBrainEvent(internalEvent, 0);
      const result = await coordinator.submitBatch({
        eventId: internalEvent.id,
        reactions: [{ username: 'bot-one', message }],
      });
      expect(result.accepted).toEqual([]);
      expect(result.rejected).toEqual(expect.arrayContaining([
        expect.objectContaining({ username: 'bot-one', reason: 'internal_metadata' }),
      ]));
    }

    expect(sent).toEqual([]);
    await coordinator.stop();
  });

  it('limits a direct question to exactly the addressed persona', async () => {
    const { coordinator } = await setup();
    const traces: ReactionTraceRecord[] = [];
    coordinator.on('trace', (trace: ReactionTraceRecord) => traces.push(trace));
    const directEvent: StreamEvent = {
      ...event,
      id: 'direct-event',
      type: 'conversation',
      source: 'chat',
      directMentions: ['bot-two'],
      viewerUsername: 'viewer',
    };
    const prepared = await coordinator.prepareBrainEvent(directEvent, 0);

    expect(prepared.event.id).toBe(directEvent.id);
    expect(prepared.recentChatDelta[0]).toMatchObject({ username: 'viewer' });
    expect(prepared.availableBots).toEqual(['bot-two']);
    expect(prepared.targetedPersonaContext.map(({ username }) => username)).toEqual(['bot-two']);
    const rejected = await coordinator.submitBatch({
      eventId: directEvent.id,
      reactions: [{ username: 'bot-three', message: 'пытаюсь ответить не своей личностью' }],
    });
    expect(rejected.rejected[0]).toMatchObject({ username: 'bot-three', reason: 'unknown_candidate' });
    expect(traces.at(-1)).toMatchObject({
      eventId: directEvent.id,
      stage: 'POLICY_VALIDATED',
      outcome: 'FAILED',
      geminiSelected: ['bot-three'],
      policyRejected: [{ username: 'bot-three', reason: 'unknown_candidate' }],
      terminalReason: 'all_selected_reactions_rejected',
    });
    await coordinator.stop();
  });

  it('sends only targeted private context for the exact directly addressed persona', async () => {
    const { coordinator, setCandidates } = await setup();
    const other = bot('bot-one', 0);
    other.persona = { ...other.persona, familyBackground: 'SECRET_OTHER_PERSONA_CANON' };
    setCandidates([other, bot('bot-two', 1), bot('bot-three', 2)]);
    const directEvent: StreamEvent = {
      ...event,
      id: 'brain-targeted-direct',
      type: 'direct_mention',
      source: 'chat',
      summary: 'viewer спросил bot-two о семье',
      speech: '@bot-two как зовут твоего дядю?',
      directMentions: ['bot-two'],
      viewerUsername: 'viewer',
    };

    const prepared = await coordinator.prepareBrainEvent(directEvent, event.timestamp - 1);

    expect(prepared.availableBots).toEqual(['bot-two']);
    expect(prepared.targetedPersonaContext.map(({ username }) => username)).toEqual(['bot-two']);
    expect(JSON.stringify(prepared)).not.toContain('SECRET_OTHER_PERSONA_CANON');
    expect(prepared).not.toHaveProperty('personas');
    await coordinator.stop();
  });

  it('supplies all four eligible bots for an ordinary event', async () => {
    const { coordinator, setCandidates } = await setup();
    setCandidates([
      bot('bot-one', 0), bot('bot-two', 1), bot('bot-three', 2), bot('bot-four', 3),
    ]);

    const prepared = await coordinator.prepareBrainEvent({ ...event, id: 'four-candidates' }, 0);

    expect(prepared.availableBots).toEqual(['bot-one', 'bot-two', 'bot-three', 'bot-four']);
    await coordinator.stop();
  });

  it('traces direct-target unavailability with a concrete reason', async () => {
    const { coordinator, setCandidates } = await setup();
    const traces: ReactionTraceRecord[] = [];
    coordinator.on('trace', (trace: ReactionTraceRecord) => traces.push(trace));
    setCandidates([
      bot('bot-one', 0),
      { ...bot('bot-two', 1), connectionState: 'DISCONNECTED', chatConnected: false },
    ]);
    const directEvent = { ...event, id: 'unavailable-direct-target', directMentions: ['bot-two'] };

    const prepared = await coordinator.prepareBrainEvent(directEvent, 0);

    expect(prepared.availableBots).toEqual([]);
    expect(traces.at(-1)).toMatchObject({
      eventId: directEvent.id,
      eligibleBots: 1,
      candidateCount: 0,
      directTargetUnavailable: [{ username: 'bot-two', reason: 'not_connected' }],
    });
    await coordinator.stop();
  });

  it('schedules exactly the usernames and final messages selected by Gemini', async () => {
    vi.useFakeTimers();
    let currentTime = event.timestamp;
    const { coordinator, sent } = await setup(true, () => currentTime);
    const traces: ReactionTraceRecord[] = [];
    coordinator.on('trace', (trace: ReactionTraceRecord) => traces.push(trace));
    const detectedAt = event.timestamp - 300;
    await coordinator.prepareBrainEvent(event, 0, detectedAt);
    currentTime += 2_500;
    const result = await coordinator.submitBatch({
      eventId: event.id,
      reactions: [{ username: 'bot-three', message: 'это был ульт в параллельную вселенную' }],
    });

    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0]).toMatchObject({ username: 'bot-three' });
    expect(result.accepted[0]?.delayMs).toBe(0);
    expect(sent).toEqual([]);
    currentTime += 20;
    await vi.runAllTimersAsync();
    expect(sent).toEqual([{ username: 'bot-three', message: 'это был ульт в параллельную вселенную' }]);
    expect(traces.at(-1)).toMatchObject({
      eventId: event.id,
      stage: 'SEND_SUCCEEDED',
      eligibleBots: 3,
      candidateCount: 3,
      geminiSelected: ['bot-three'],
      policyAccepted: ['bot-three'],
      scheduled: ['bot-three'],
      sent: ['bot-three'],
      outcome: 'SENT',
      timing: {
        detectedAt,
        contextReadyAt: event.timestamp,
        decisionAt: event.timestamp + 2_500,
        completedAt: event.timestamp + 2_520,
      },
      reactions: [{
        username: 'bot-three',
        message: 'это был ульт в параллельную вселенную',
        artificialDelayMs: 0,
        status: 'SENT',
        selectedAt: event.timestamp + 2_500,
        scheduledAt: event.timestamp + 2_500,
        sentAt: event.timestamp + 2_520,
      }],
    });

    const completedTrace = traces.at(-1);
    const replay = await coordinator.submitBatch({ eventId: event.id, reactions: [] });
    expect(replay).toMatchObject({ eventId: event.id, accepted: [], stale: true });
    expect(traces.at(-1)).toEqual(completedTrace);
    await coordinator.stop();
  });

  it('accepts an empty reaction batch as a natural no-response decision', async () => {
    const { coordinator, sent, usage } = await setup();
    await coordinator.prepareBrainEvent(event, 0);
    const result = await coordinator.submitBatch({ eventId: event.id, reactions: [] });
    expect(result).toMatchObject({ accepted: [], rejected: [] });
    expect(sent).toEqual([]);
    expect(usage.snapshot().emptyReactionBatches).toBe(1);
    await coordinator.stop();
  });

  describe('Twitch delivery confirmation', () => {
    // Twitch acknowledges nothing when a message is sent and tmi.js resolves once the bytes reach
    // the socket, so a message dropped by spam handling, followers-only mode or AutoMod is
    // indistinguishable from a delivered one. The reader account seeing it come back is the only
    // real evidence, and without that the dashboard reported sends that chat never showed.
    it('marks a reaction undelivered when it never comes back through the reader account', async () => {
      vi.useFakeTimers();
      const { coordinator, usage, setObservesChat } = await setup();
      usage.startStream();
      setObservesChat(true);
      const traces: ReactionTraceRecord[] = [];
      coordinator.on('trace', (trace: ReactionTraceRecord) => traces.push(trace));
      await coordinator.prepareBrainEvent(event, 0);
      await coordinator.submitBatch({
        eventId: event.id,
        reactions: [{ username: 'bot-three', message: 'это был ульт в параллельную вселенную' }],
      });
      await vi.runOnlyPendingTimersAsync();
      expect(usage.snapshot().currentStream.undeliveredMessages).toBe(0);

      await vi.advanceTimersByTimeAsync(10_000);
      expect(usage.snapshot().currentStream.undeliveredMessages).toBe(1);
      expect(usage.snapshot().currentStream.confirmedDeliveries).toBe(0);
      expect(traces.at(-1)?.reactions?.[0]).toMatchObject({ username: 'bot-three', status: 'UNDELIVERED' });
      await coordinator.stop();
    });

    it('confirms a reaction that comes back through the reader account and never flags it', async () => {
      vi.useFakeTimers();
      const { coordinator, usage, setObservesChat } = await setup();
      usage.startStream();
      setObservesChat(true);
      await coordinator.prepareBrainEvent(event, 0);
      await coordinator.submitBatch({
        eventId: event.id,
        reactions: [{ username: 'bot-three', message: 'это был ульт в параллельную вселенную' }],
      });
      await vi.runOnlyPendingTimersAsync();
      // Whitespace differs from what was sent; the channel showed the same message all the same.
      coordinator.confirmDelivery('bot-three', '  это был ульт  в параллельную вселенную ');

      await vi.advanceTimersByTimeAsync(30_000);
      expect(usage.snapshot().currentStream.confirmedDeliveries).toBe(1);
      expect(usage.snapshot().currentStream.undeliveredMessages).toBe(0);
      await coordinator.stop();
    });

    it('uses the reason Twitch reported instead of waiting out the echo window', async () => {
      vi.useFakeTimers();
      const { coordinator, usage, setObservesChat } = await setup();
      usage.startStream();
      setObservesChat(true);
      const traces: ReactionTraceRecord[] = [];
      coordinator.on('trace', (trace: ReactionTraceRecord) => traces.push(trace));
      await coordinator.prepareBrainEvent(event, 0);
      await coordinator.submitBatch({
        eventId: event.id,
        reactions: [{ username: 'bot-three', message: 'это был ульт в параллельную вселенную' }],
      });
      await vi.runOnlyPendingTimersAsync();

      // Twitch reports refusals as an IRC NOTICE on the sending account's connection, never as an
      // error from say(); that reason is far more useful than a generic non-appearance.
      coordinator.rejectDelivery('bot-three', 'msg_followersonly');
      expect(usage.snapshot().currentStream.undeliveredMessages).toBe(1);
      expect(traces.at(-1)?.reactions?.[0]).toMatchObject({
        username: 'bot-three', status: 'UNDELIVERED', failureReason: 'msg_followersonly',
      });

      // The echo watchdog must not fire again for a delivery already accounted for.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(usage.snapshot().currentStream.undeliveredMessages).toBe(1);
      await coordinator.stop();
    });

    it('judges nothing while no account is reading chat, instead of calling every send undelivered', async () => {
      vi.useFakeTimers();
      const { coordinator, usage } = await setup();
      usage.startStream();
      await coordinator.prepareBrainEvent(event, 0);
      await coordinator.submitBatch({
        eventId: event.id,
        reactions: [{ username: 'bot-three', message: 'это был ульт в параллельную вселенную' }],
      });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(usage.snapshot().currentStream.undeliveredMessages).toBe(0);
      expect(usage.snapshot().currentStream.confirmedDeliveries).toBe(0);
      await coordinator.stop();
    });
  });

  it('spaces accounts in one batch so two never reach Twitch in the same instant', async () => {
    vi.useFakeTimers();
    const { coordinator } = await setup();
    await coordinator.prepareBrainEvent(event, 0);
    const result = await coordinator.submitBatch({
      eventId: event.id,
      reactions: [
        { username: 'bot-one', message: 'первая реплика про этот момент' },
        { username: 'bot-three', message: 'вторая реплика совершенно другая' },
      ],
    });
    // The first account still answers immediately — this is transport spacing, not a typing delay.
    expect(result.accepted.map((item) => item.delayMs)).toEqual([0, 900]);
    await coordinator.stop();
  });

  it('sends what was actually said alongside perception\'s retelling of it', async () => {
    const { coordinator, contextStore } = await setup();
    // Perception already transcribes the stream, and those words were read only to spot a spoken
    // bot name and then dropped — leaving the decision layer with a retelling that turns "we are
    // trying to drag him along for drinks" into "proposes some sort of plan".
    contextStore.addSpeech('мы пытаемся его взять с собой бухать', event.timestamp - 1_000);
    contextStore.addSpeech('слишком старое', event.timestamp - 600_000);
    const prepared = await coordinator.prepareBrainEvent(event, event.timestamp - 5_000);
    expect(prepared.recentSpeech?.map((line) => line.text)).toEqual(['мы пытаемся его взять с собой бухать']);
    await coordinator.stop();
  });

  it('rejects a typographic dash outright rather than asking the model not to use one', async () => {
    // Nobody types an em dash into a chat box; it is the clearest tell that a message was written
    // rather than typed, and three separate instructions failed to stop it appearing.
    const { coordinator } = await setup();
    await coordinator.prepareBrainEvent(event, 0);
    const result = await coordinator.submitBatch({
      eventId: event.id,
      reactions: [
        { username: 'bot-one', message: 'работает — не трогай, золотое правило' },
        { username: 'bot-three', message: 'работает, не трогай' },
      ],
    });
    expect(result.rejected).toContainEqual({ username: 'bot-one', reason: 'typographic_dash' });
    expect(result.accepted.map((item) => item.username)).toEqual(['bot-three']);
    await coordinator.stop();
  });

  it('puts what each account personally remembers in front of the model on an ordinary moment', async () => {
    // Memory is where a character's opinions live, and it used to reach the model only when the
    // stream said that account's name. Every ordinary moment was answered by accounts with no
    // history of their own, which is most of why the messages read as commentary.
    const { coordinator, personaMemory, candidatesFor } = await setup();
    const persona = candidatesFor('bot-two');
    await personaMemory.remember({
      personaId: persona.persona.id,
      type: 'preference',
      summary: 'Терпеть не может, когда в такси громко играет музыка.',
      importance: 0.8,
      tags: ['такси'],
      // Recall deliberately ignores something stored moments ago, so this one is from earlier.
      createdAt: event.timestamp - 3_600_000,
    });

    const prepared = await coordinator.prepareBrainEvent({ ...event, id: 'ordinary-event' }, 0);
    const recalled = prepared.recalledMemories?.find((item) => item.username === 'bot-two');
    expect(recalled?.memories).toEqual([
      expect.objectContaining({ summary: 'Терпеть не может, когда в такси громко играет музыка.' }),
    ]);
    // Nobody else's memory travels with it.
    for (const entry of prepared.recalledMemories ?? []) {
      if (entry.username === 'bot-two') continue;
      expect(entry.memories).toEqual([]);
    }
    await coordinator.stop();
  });

  it('tells the brain how a moment sits with each account, not who is due a turn', async () => {
    // Fit comes from the character: what they usually notice and what they pass over. Selection
    // used to be told that an account which had been quiet was the stronger choice, which is a
    // rotation dressed as a judgement.
    const { coordinator, candidatesFor, setCandidates } = await setup();
    const noticesFails = candidatesFor('bot-one');
    noticesFails.persona.behavior.activity.preferredEventTypes = ['fail'];
    noticesFails.persona.behavior.activity.ignoredEventTypes = [];
    const ignoresFails = candidatesFor('bot-two');
    ignoresFails.persona.behavior.activity.preferredEventTypes = [];
    ignoresFails.persona.behavior.activity.ignoredEventTypes = ['fail'];
    setCandidates([noticesFails, ignoresFails, candidatesFor('bot-three')]);

    // The event fixture is a 'fail'.
    const prepared = await coordinator.prepareBrainEvent({ ...event, id: 'fit-event' }, 0);
    const states = prepared.candidateStates ?? [];
    expect(states.find((state) => state.username === 'bot-one')?.attention).toBe('notices');
    expect(states.find((state) => state.username === 'bot-two')?.attention).toBe('passes over');
    expect(states.find((state) => state.username === 'bot-three')?.attention).toBe('no strong pattern');
    // No number beside it. A raw eventSelectivity here was a second cooldown applied to candidates
    // the backend had already cleared, and it never once told two of them apart.
    expect(JSON.stringify(states)).not.toContain('selectivity');
    await coordinator.stop();
  });

  it('turns a message that only grades the moment into silence, before anything is reserved', async () => {
    // The whole point of sitting ahead of the policy guard: a message with no reaction in it should
    // not spend a rate-limit slot or an account's cooldown on the way to being dropped.
    vi.useFakeTimers();
    const { coordinator, sent, policy, logged } = await setup(true, () => event.timestamp, true);
    const yandex: StreamEvent = {
      ...event,
      id: 'yandex-event',
      type: 'question',
      summary: 'O: Maybe... I support Yandex. S: Yandex? Yandex? Oh. Yandex so good.',
      speech: 'O: Maybe... I support Yandex. S: Yandex? Yandex? Oh. Yandex so good.',
    };
    await coordinator.prepareBrainEvent(yandex, 0);
    const result = await coordinator.submitBatch({
      eventId: 'yandex-event',
      reactions: [{ username: 'bot-one', message: 'Яндекс это мощно конечно' }],
    });
    await vi.advanceTimersByTimeAsync(10_000);

    expect(sent).toHaveLength(0);
    expect(result.accepted).toEqual([]);
    expect(result.rejected).toEqual([{ username: 'bot-one', reason: 'generic_evaluator' }]);
    // Nothing was reserved on its behalf, so the next real message still has its slot.
    expect(policy.globalSlotsAvailable()).toBe(2);
    // And it is distinguishable afterwards from the Brain having chosen silence.
    expect(logged().some((entry) => entry.message === 'Reaction dropped as commentary rather than reaction'
      && entry.reason === 'generic_evaluator')).toBe(true);
    await coordinator.stop();
    vi.restoreAllMocks();
  });

  it('still sends a real answer to the same kind of moment', async () => {
    // The guard must not be a general filter on short messages about a subject the stream raised.
    vi.useFakeTimers();
    const { coordinator, sent } = await setup();
    const asked: StreamEvent = {
      ...event,
      id: 'garena-event',
      type: 'question',
      summary: 'S: I ICCup, Garena. You know what is this, man?',
      speech: 'S: I ICCup, Garena. You know what is this, man?',
      audience: 'twitch_chat',
      audienceConfidence: 0.9,
    };
    await coordinator.prepareBrainEvent(asked, 0);
    await coordinator.submitBatch({
      eventId: 'garena-event',
      reactions: [{ username: 'bot-one', message: 'олды на месте' }],
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sent).toEqual([{ username: 'bot-one', message: 'олды на месте' }]);
    await coordinator.stop();
  });

  it('adds the first-message condition only while the session has said nothing', async () => {
    // Cases A and B: the first line of an evening is the one with no established voice behind it,
    // and it is where the safe default appears. The condition rides in the payload rather than the
    // system instruction, so it is gone the moment it stops being true instead of being read by
    // every later decision.
    const { coordinator, setColdStart } = await setup();
    setColdStart(true);
    const cold = await coordinator.prepareBrainEvent({ ...event, id: 'cold-event' }, 0);
    expect(cold.firstMessageGate).toContain('Nothing has been sent this session yet');
    expect(cold.firstMessageGate).toContain('It may be one word');

    setColdStart(false);
    const warm = await coordinator.prepareBrainEvent({ ...event, id: 'warm-event' }, 0);
    expect(warm).not.toHaveProperty('firstMessageGate');
    await coordinator.stop();
  });

  it('retires the gate on a message that reached Twitch, not on one that was merely accepted', async () => {
    // Case I against Case J. A reaction the guard accepted and the sender then failed to deliver has
    // introduced these accounts to nobody, so the session is still cold.
    vi.useFakeTimers();
    const failing = await setup(false);
    failing.setColdStart(true);
    await failing.coordinator.prepareBrainEvent({ ...event, id: 'failed-send' }, 0);
    await failing.coordinator.submitBatch({
      eventId: 'failed-send',
      reactions: [{ username: 'bot-one', message: 'ахах' }],
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(failing.sent).toHaveLength(1);
    expect(failing.messageSentCalls()).toBe(0);
    await failing.coordinator.stop();

    const landing = await setup(true);
    landing.setColdStart(true);
    await landing.coordinator.prepareBrainEvent({ ...event, id: 'good-send' }, 0);
    await landing.coordinator.submitBatch({
      eventId: 'good-send',
      reactions: [{ username: 'bot-one', message: 'ахах' }],
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(landing.messageSentCalls()).toBe(1);
    await landing.coordinator.stop();
  });

  it('records whether a decision was taken before the session had said anything', async () => {
    const { coordinator, setColdStart, logged } = await setup(true, () => event.timestamp, true);
    setColdStart(true);
    await coordinator.prepareBrainEvent({ ...event, id: 'cold-decision' }, 0);
    await coordinator.submitBatch({ eventId: 'cold-decision', reactions: [] });
    const decision = logged().find((entry) => entry.message === 'Gemini reaction batch validated');
    expect(decision).toMatchObject({ coldStartQualityModeActive: true, selected: [] });
    await coordinator.stop();
    vi.restoreAllMocks();
  });

  it('carries the addressee and what was observable into the decision it logs', async () => {
    // "тут мы, смотрим" answered a teammate being called by name, and "в настройках интерфейса галка
    // на миникарту" invented a menu path. Neither is diagnosable after the fact unless the decision
    // line says who perception thought was being addressed and what the moment actually contained.
    const { coordinator, logged } = await setup(true, () => event.timestamp, true);
    await coordinator.prepareBrainEvent({
      ...event,
      id: 'addressed-event',
      type: 'question',
      summary: 'O: Вы где там, Артём?',
      speech: 'O: Вы где там, Артём?',
      visualContext: 'Стример за монитором с приостановленной игрой.',
      audience: 'people_with_streamer',
      audienceConfidence: 0.8,
    }, 0);
    await coordinator.submitBatch({ eventId: 'addressed-event', reactions: [] });

    const decision = logged().find((entry) => entry.message === 'Gemini reaction batch validated');
    expect(decision).toMatchObject({
      audience: 'people_with_streamer',
      audienceConfidence: 0.8,
      grounding: 'speech+scene',
      selected: [],
      eventType: 'question',
    });
    await coordinator.stop();
    vi.restoreAllMocks();
  });

  it('notices a moment about what an account actually cares about, however choosy it is', async () => {
    // The event-type lists are catalogue labels — 'football', 'gossip', 'dota-analysis' — and the
    // perception layer emits 'speech', 'question', 'conversation'. Over a measured stream the two
    // vocabularies met three times in thirty-one moments, so fit was decided by a field that was
    // almost always the same value for everybody. Interests are written in the language the stream
    // is actually spoken in, and that is what carries the signal now.
    const { coordinator, candidatesFor, setCandidates } = await setup();
    const archivist = candidatesFor('bot-three');
    expect(archivist.persona.behavior.activity.eventSelectivity).toBeGreaterThan(0.9);
    expect(archivist.persona.interests.other).toContain('плёночная фотография');
    setCandidates([archivist, candidatesFor('bot-one')]);

    const relevant = await coordinator.prepareBrainEvent({
      ...event,
      id: 'topical-event',
      type: 'speech',
      summary: 'S: смотри, тут плёночная фотография на стене висит',
    }, 0);
    expect(relevant.candidateStates?.find((state) => state.username === 'bot-three')?.attention)
      .toBe('notices');

    // And an unrelated one stays unremarkable for them, which is equally correct.
    const unrelated = await coordinator.prepareBrainEvent({
      ...event,
      id: 'off-topic-event',
      type: 'speech',
      summary: 'S: короче я вчера колесо менял полтора часа',
    }, 0);
    expect(unrelated.candidateStates?.find((state) => state.username === 'bot-three')?.attention)
      .toBe('no strong pattern');
    await coordinator.stop();
  });

  it('lets an ordinary moment be answered by one account and a big one by more', async () => {
    // The ceiling handed to the brain follows the moment, not only the size of the crowd.
    const { coordinator, policy } = await setup();
    const ordinary = await coordinator.prepareBrainEvent(
      { ...event, id: 'ordinary', importance: 0.45 }, 0,
    );
    expect(ordinary.constraints.maxReactions).toBe(1);

    const striking = await coordinator.prepareBrainEvent(
      { ...event, id: 'striking', importance: 0.95 }, 0,
    );
    expect(striking.constraints.maxReactions).toBe(policy.maxReactionsFor(3, 0.95));
    await coordinator.stop();
  });

  it('scales how many accounts answer one moment with how many are available', async () => {
    // A fixed three was written for a full chat and reads as a pile-up on a small one: with four
    // accounts connected, two answered the same event a second apart with two wordings of one
    // thought, three times in seven minutes.
    const policy = new ReactionPolicyGuard({
      globalMessagesPer30Seconds: 60, maxReactionsPerEvent: 5, now: () => event.timestamp,
    });
    expect(policy.maxReactionsFor(0)).toBe(0);
    expect(policy.maxReactionsFor(1)).toBe(1);
    expect(policy.maxReactionsFor(4)).toBe(1);
    expect(policy.maxReactionsFor(10)).toBe(2);
    expect(policy.maxReactionsFor(20)).toBe(3);
    expect(policy.maxReactionsFor(30)).toBe(5);
    // Never above the configured ceiling, whatever the crowd.
    expect(policy.maxReactionsFor(200)).toBe(5);
  });

  describe('candidate shortlisting for a roster past the target size', () => {
    // Twenty-nine equally-shaped candidate entries is what a live run actually looked like: a
    // measured session put attention at 'notices' for 63 of 449 checks and 'no strong pattern' for
    // the rest, and every one of those twenty-nine went into the same payload regardless. These build
    // a crowd well past SHORTLIST_TARGET_SIZE and check what actually reaches the Brain.
    function crowd(size: number): ReactionBotCandidate[] {
      return Array.from({ length: size }, (_, index) => {
        const base = CANDIDATE_PERSONAS[index % CANDIDATE_PERSONAS.length]!;
        return {
          username: `crowd-${index}`,
          persona: { ...base, behavior: { ...base.behavior, minimumIntervalMs: 30_000 } },
          enabled: true, connectionState: 'CONNECTED' as const, chatConnected: true,
        };
      });
    }

    it('shows the Brain a shortlist rather than the full roster, once the pool passes the target size', async () => {
      const { coordinator, setCandidates, policy } = await setup();
      setCandidates(crowd(12));
      const prepared = await coordinator.prepareBrainEvent(
        { ...event, id: 'crowded-event', summary: 'секунда тишины в чате' }, 0,
      );
      expect(prepared.candidateStates?.length).toBeLessThan(12);
      expect(prepared.candidateStates?.length).toBeLessThanOrEqual(SHORTLIST_TARGET_SIZE);
      expect(prepared.availableBots).toHaveLength(prepared.candidateStates!.length);
      // The ceiling still follows the full room, not the smaller set the Brain was actually shown —
      // an ordinary remark stays one voice at most however many of the twelve made the shortlist.
      expect(prepared.constraints.maxReactions).toBe(policy.maxReactionsFor(12, event.importance));
      await coordinator.stop();
    });

    it('keeps a topically-relevant account in the shortlist out of a crowd past the target size', async () => {
      const { coordinator, candidatesFor, setCandidates } = await setup();
      const archivist = candidatesFor('bot-three');
      expect(archivist.persona.interests.other).toContain('плёночная фотография');
      setCandidates([{ ...archivist, username: 'the-archivist' }, ...crowd(11)]);
      const prepared = await coordinator.prepareBrainEvent({
        ...event, id: 'topical-crowded-event', type: 'speech',
        summary: 'S: смотри, тут плёночная фотография на стене висит',
      }, 0);
      expect(prepared.candidateStates?.length).toBeLessThan(12);
      expect(prepared.candidateStates?.find((state) => state.username === 'the-archivist')?.attention)
        .toBe('notices');
      await coordinator.stop();
    });

    it('never trims a directly-mentioned account, even when more accounts are mentioned than the shortlist target', async () => {
      const { coordinator, setCandidates } = await setup();
      const pool = crowd(12);
      setCandidates(pool);
      const mentioned = pool.slice(0, 9).map((candidate) => candidate.username);
      const prepared = await coordinator.prepareBrainEvent(
        { ...event, id: 'many-mentions-event', directMentions: mentioned }, 0,
      );
      expect(prepared.candidateStates?.map((state) => state.username).sort()).toEqual([...mentioned].sort());
      await coordinator.stop();
    });
  });

  describe('learned policy reaching a real decision payload', () => {
    async function policyStoreWith(rules: Array<Partial<LearnedPolicyRule> & { id: string }>): Promise<LearnedPolicyStore> {
      const repository = new MemoryRepository();
      await repository.initialize();
      await repository.applyLearnedPolicyBatch({
        upserts: rules.map((partial) => ({
          scopeType: 'global' as const, scopeKey: '', rule: 'A rule.', rationale: 'because',
          confidence: 0.85, supportCount: 2, positiveEvidence: 0, negativeEvidence: 2,
          status: 'active' as const, teacherModel: 'test/teacher', evidenceIds: [],
          createdAt: 1_000, updatedAt: 1_000, version: 1, ...partial,
        })),
        processedVerdictIds: [], processedAt: 1_000,
      });
      const store = new LearnedPolicyStore(repository, new Logger('TEST', 'error'));
      await store.load();
      return store;
    }

    it('carries a global rule into the event payload without touching the permanent instruction', async () => {
      const learnedPolicy = await policyStoreWith([{
        id: 'r1', rule: 'Do not restate an opinion the stream already expressed just to agree with it.',
      }]);
      const { coordinator } = await setup(true, () => event.timestamp, false, undefined, learnedPolicy);
      const prepared = await coordinator.prepareBrainEvent(event, 0);
      expect(prepared.learnedPolicy?.global)
        .toEqual(['Do not restate an opinion the stream already expressed just to agree with it.']);
      expect(prepared.learnedPolicy?.guidance).toContain('operator');
      await coordinator.stop();
    });

    it('keys a persona rule to its own account, so one account\'s correction is not read as everyone\'s', async () => {
      const learnedPolicy = await policyStoreWith([{
        id: 'r1', scopeType: 'persona', scopeKey: 'bot-two',
        rule: 'bot-two must not give confident advice about Dota.',
      }]);
      const { coordinator } = await setup(true, () => event.timestamp, false, undefined, learnedPolicy);
      const prepared = await coordinator.prepareBrainEvent(event, 0);
      expect(prepared.learnedPolicy?.byPersona).toEqual({
        'bot-two': ['bot-two must not give confident advice about Dota.'],
      });
      expect(prepared.learnedPolicy?.global).toEqual([]);
      await coordinator.stop();
    });

    it('omits the block entirely when nothing has been learned', async () => {
      const learnedPolicy = await policyStoreWith([]);
      const { coordinator } = await setup(true, () => event.timestamp, false, undefined, learnedPolicy);
      const prepared = await coordinator.prepareBrainEvent(event, 0);
      expect(prepared).not.toHaveProperty('learnedPolicy');
      await coordinator.stop();
    });

    it('records which rules a decision was given, in the decision log rather than the payload', async () => {
      const learnedPolicy = await policyStoreWith([{ id: 'r1', rule: 'A standing correction.' }]);
      const { coordinator, logged } = await setup(true, () => event.timestamp, true, undefined, learnedPolicy);
      await coordinator.prepareBrainEvent(event, 0);
      await coordinator.submitBatch({ eventId: event.id, reactions: [] });
      const decision = logged().find((entry) => entry.message === 'Gemini reaction batch validated');
      expect(decision).toMatchObject({ learnedRulesApplied: 1, learnedRuleIds: ['r1'], learnedRuleScopes: ['global'] });
      await coordinator.stop();
      vi.restoreAllMocks();
    });
  });

  describe('operator feedback: near-duplicate-of-disliked suppression', () => {
    async function feedbackStoreWith(verdict: { username: string; message: string; verdict: 'good' | 'bad' }): Promise<PersonaFeedbackStore> {
      const store = new PersonaFeedbackStore(
        { saveMessageVerdict: async () => undefined, listMessageVerdicts: async () => [] },
        new Logger('TEST', 'error'),
      );
      await store.record(verdict);
      return store;
    }

    it('rejects a reaction that closely matches a message this account was disliked for before', async () => {
      const feedbackStore = await feedbackStoreWith({ username: 'bot-one', message: 'го дальше по классике чё как', verdict: 'bad' });
      const { coordinator } = await setup(true, () => event.timestamp, false, feedbackStore);
      await coordinator.prepareBrainEvent(event, 0);
      const result = await coordinator.submitBatch({
        eventId: event.id,
        reactions: [{ username: 'bot-one', message: 'го дальше по классике чё как' }],
      });
      expect(result.accepted).toEqual([]);
      expect(result.rejected).toEqual(expect.arrayContaining([
        expect.objectContaining({ username: 'bot-one', reason: 'disliked_near_duplicate' }),
      ]));
      await coordinator.stop();
    });

    it('still accepts a genuinely different message from the same account', async () => {
      const feedbackStore = await feedbackStoreWith({ username: 'bot-one', message: 'го дальше по классике чё как', verdict: 'bad' });
      const { coordinator } = await setup(true, () => event.timestamp, false, feedbackStore);
      await coordinator.prepareBrainEvent(event, 0);
      const result = await coordinator.submitBatch({
        eventId: event.id,
        reactions: [{ username: 'bot-one', message: 'кто-нибудь смотрел новый сериал' }],
      });
      expect(result.accepted.map((item) => item.username)).toEqual(['bot-one']);
      await coordinator.stop();
    });
  });

  it('keeps an account that cannot send out of the decision entirely', async () => {
    // Offering a cooling account meant paying for a message the guard then binned: a measured
    // fourteen minutes threw away 37 reactions to account_cooldown, and thirteen of thirty-four
    // decisions came back empty while the dashboard called it deliberate silence.
    const { coordinator, policy, setCandidates } = await setup();
    const cooling = bot('bot-one', 0);
    cooling.lastReactionAt = event.timestamp - 1_000;
    setCandidates([cooling, bot('bot-two', 1), bot('bot-three', 2)]);
    expect(policy.candidateRateLimit(cooling).cooldownRemainingMs).toBeGreaterThan(0);

    const prepared = await coordinator.prepareBrainEvent(event, 0);
    expect(prepared.availableBots).toEqual(['bot-two', 'bot-three']);
    await coordinator.stop();
  });

  it('still offers a cooling account when the stream said its name', async () => {
    // Leaving a question addressed to one account unanswered is worse than answering it early.
    const { coordinator, setCandidates } = await setup();
    const cooling = bot('bot-one', 0);
    cooling.lastReactionAt = event.timestamp - 1_000;
    setCandidates([cooling, bot('bot-two', 1)]);

    const prepared = await coordinator.prepareBrainEvent({
      ...event, id: 'named-event', summary: 'bot-one а ты что думаешь', speech: 'bot-one а ты что думаешь',
      directMentions: ['bot-one'],
    }, 0);
    expect(prepared.availableBots).toEqual(['bot-one']);
    await coordinator.stop();
  });

  it('sends a reply the queue delayed rather than throwing it away', async () => {
    // A freshness gate used to bin anything older than twelve seconds, and a backed-up queue made
    // that five of fourteen messages: paid for, written, discarded. Lateness is a queue problem and
    // gets fixed there; a good message is worth more late than never.
    vi.useFakeTimers();
    let clock = event.timestamp;
    const { coordinator, sent } = await setup(true, () => clock);
    await coordinator.prepareBrainEvent(event, 0);
    const result = await coordinator.submitBatch({
      eventId: event.id,
      reactions: [{ username: 'bot-one', message: 'картошку хоть не испортили?' }],
    });
    expect(result.accepted).toHaveLength(1);

    clock += 30_000;
    await vi.runAllTimersAsync();
    expect(sent).toEqual([{ username: 'bot-one', message: 'картошку хоть не испортили?' }]);
    await coordinator.stop();
  });

  it('never spends a Brain call when the named account is unavailable', async () => {
    const { coordinator, setCandidates } = await setup();
    const traces: ReactionTraceRecord[] = [];
    coordinator.on('trace', (trace: ReactionTraceRecord) => traces.push(trace));
    setCandidates([bot('bot-one', 0)]);
    const prepared = await coordinator.prepareBrainEvent(
      { ...event, id: 'event-mention', type: 'direct_mention', directMentions: ['bot-two'] }, 0,
    );
    // A spoken name recognised for a configured but currently unavailable account: nobody can
    // answer, so asking the model to choose from an empty list could only ever return silence.
    expect(prepared.availableBots).toEqual([]);
    expect(traces.at(-1)).toMatchObject({ outcome: 'FAILED', terminalReason: 'no_available_candidate' });
    await coordinator.stop();
  });

  it('traces a scheduled Twitch send failure to its terminal reason', async () => {
    vi.useFakeTimers();
    const { coordinator } = await setup(false);
    const traces: ReactionTraceRecord[] = [];
    coordinator.on('trace', (trace: ReactionTraceRecord) => traces.push(trace));
    const failedEvent = { ...event, id: 'send-failure-event' };
    await coordinator.prepareBrainEvent(failedEvent, 0);
    const result = await coordinator.submitBatch({
      eventId: failedEvent.id,
      reactions: [{ username: 'bot-one', message: 'valid message that the sender cannot deliver' }],
    });
    expect(result.accepted).toHaveLength(1);

    await vi.runAllTimersAsync();

    expect(traces.at(-1)).toMatchObject({
      eventId: failedEvent.id,
      stage: 'SEND_FAILED',
      outcome: 'FAILED',
      scheduled: ['bot-one'],
      sent: [],
      sendFailed: [{ username: 'bot-one', reason: 'twitch_send_failed' }],
    });
    await coordinator.stop();
  });

  it('records Twitch submission before persistence and never rewrites it as failed', async () => {
    vi.useFakeTimers();
    let currentTime = event.timestamp;
    const { coordinator, history } = await setup(true, () => currentTime);
    const traces: ReactionTraceRecord[] = [];
    coordinator.on('trace', (trace: ReactionTraceRecord) => traces.push(trace));
    const submittedEvent = { ...event, id: 'send-before-persistence' };
    await coordinator.prepareBrainEvent(submittedEvent, 0);
    currentTime += 1_000;
    vi.spyOn(history, 'add').mockImplementationOnce(async () => {
      currentTime += 5_000;
      throw new Error('database unavailable after Twitch submission');
    });
    await coordinator.submitBatch({
      eventId: submittedEvent.id,
      reactions: [{ username: 'bot-one', message: 'сообщение уже принял Twitch' }],
    });
    currentTime += 25;

    await vi.runAllTimersAsync();

    expect(traces.at(-1)).toMatchObject({
      eventId: submittedEvent.id,
      stage: 'SEND_SUCCEEDED',
      outcome: 'SENT',
      timing: { completedAt: event.timestamp + 1_025 },
      reactions: [{
        username: 'bot-one',
        status: 'SENT',
        sentAt: event.timestamp + 1_025,
      }],
    });
    await coordinator.stop();
  });

  it('keeps partial-send terminal metadata stable regardless of completion order', async () => {
    vi.useFakeTimers();

    const run = async (usernames: string[], eventId: string): Promise<ReactionTraceRecord> => {
      let currentTime = event.timestamp;
      const { coordinator } = await setup((username) => username !== 'bot-one', () => currentTime);
      const traces: ReactionTraceRecord[] = [];
      coordinator.on('trace', (trace: ReactionTraceRecord) => traces.push(trace));
      const mixedEvent = { ...event, id: eventId };
    await coordinator.prepareBrainEvent(mixedEvent, 0);
      await coordinator.submitBatch({
        eventId,
        reactions: usernames.map((username) => ({ username, message: `сообщение от ${username}` })),
      });
      currentTime += 15;
      await vi.runAllTimersAsync();
      const completed = traces.at(-1)!;
      await coordinator.stop();
      return completed;
    };

    const failureThenSuccess = await run(['bot-one', 'bot-three'], 'mixed-failure-first');
    const successThenFailure = await run(['bot-three', 'bot-one'], 'mixed-success-first');

    for (const trace of [failureThenSuccess, successThenFailure]) {
      expect(trace).toMatchObject({ outcome: 'PARTIAL', terminalReason: 'some_reactions_failed' });
      expect(trace.reactions).toEqual(expect.arrayContaining([
        expect.objectContaining({ username: 'bot-one', status: 'FAILED' }),
        expect.objectContaining({ username: 'bot-three', status: 'SENT' }),
      ]));
    }
  });

  it('rejects duplicate usernames and disconnected accounts without cancelling valid items', async () => {
    vi.useFakeTimers();
    const { coordinator, sent, setCandidates } = await setup();
    await coordinator.prepareBrainEvent(event, 0);
    setCandidates([
      bot('bot-one', 0),
      { ...bot('bot-two', 1), connectionState: 'DISCONNECTED', chatConnected: false },
      bot('bot-three', 2),
    ]);
    const result = await coordinator.submitBatch({
      eventId: event.id,
      reactions: [
        { username: 'bot-one', message: 'первый нормальный ответ' },
        { username: 'broken', message: 42 },
        { username: 'bot-one', message: 'второй ответ тем же аккаунтом' },
        { username: 'bot-two', message: 'я сейчас не подключен' },
        { username: 'bot-three', message: 'а вот этот тоже можно отправить' },
      ],
    });
    expect(result.accepted.map((item) => item.username)).toEqual(['bot-one', 'bot-three']);
    expect(result.rejected).toEqual(expect.arrayContaining([
      expect.objectContaining({ username: 'bot-one', reason: 'duplicate_username' }),
      expect.objectContaining({ username: 'broken', reason: 'invalid_item' }),
      expect.objectContaining({ username: 'bot-two', reason: 'not_connected' }),
    ]));
    await vi.runAllTimersAsync();
    expect(sent.map((item) => item.username)).toEqual(['bot-one', 'bot-three']);
    await coordinator.stop();
  });

  it('rejects candidate usernames whose casing or whitespace is not copied exactly', async () => {
    const { coordinator } = await setup();
    const exactEvent = { ...event, id: 'exact-username-event' };
    await coordinator.prepareBrainEvent(exactEvent, 0);

    const result = await coordinator.submitBatch({
      eventId: exactEvent.id,
      reactions: [
        { username: 'BOT-ONE', message: 'wrong casing' },
        { username: ' bot-two ', message: 'extra whitespace' },
      ],
    });

    expect(result.accepted).toEqual([]);
    expect(result.rejected).toEqual([
      { username: 'bot-one', reason: 'unknown_candidate' },
      { username: 'bot-two', reason: 'unknown_candidate' },
    ]);
    await coordinator.stop();
  });

  it('rejects a recent duplicate but still sends another persona reaction', async () => {
    vi.useFakeTimers();
    const { coordinator, history, sent } = await setup();
    await history.add('bot-one', 'ну это был ульт года');
    await coordinator.prepareBrainEvent(event, 0);
    const result = await coordinator.submitBatch({
      eventId: event.id,
      reactions: [
        { username: 'bot-one', message: 'ну это ульт года' },
        { username: 'bot-two', message: 'карта увернулась заранее' },
      ],
    });
    expect(result.rejected[0]).toMatchObject({ username: 'bot-one', reason: 'recent_duplicate' });
    expect(result.accepted.map((item) => item.username)).toEqual(['bot-two']);
    await vi.runAllTimersAsync();
    expect(sent).toEqual([{ username: 'bot-two', message: 'карта увернулась заранее' }]);
    await coordinator.stop();
  });

  it('enforces a hard rolling global rate limit', async () => {
    const { policy } = await setup();
    policy.recordSent(event.timestamp - 100);
    policy.recordSent(event.timestamp - 50);
    const result = await policy.validateBatch({
      trigger: { kind: 'stream_event', event },
      permittedUsernames: new Set(['bot-one']),
      currentCandidates: [bot('bot-one', 0)],
      reactions: [{ username: 'bot-one', message: 'валидное уникальное сообщение' }],
      isDuplicate: async () => false,
    });
    expect(result.accepted).toEqual([]);
    expect(result.rejected[0]).toMatchObject({ reason: 'global_rate_limit' });
  });

  it('rejects an already consumed event context as stale', async () => {
    const { coordinator } = await setup();
    await coordinator.prepareBrainEvent(event, 0);
    await coordinator.submitBatch({ eventId: event.id, reactions: [] });
    const replay = await coordinator.submitBatch({ eventId: event.id, reactions: [] });
    expect(replay).toMatchObject({ eventId: event.id, accepted: [], stale: true });
    await coordinator.stop();
  });

  it('cancels a queued message when the account persona changes before send', async () => {
    vi.useFakeTimers();
    const { coordinator, sent, setCandidates } = await setup();
    await coordinator.prepareBrainEvent(event, 0);
    const accepted = await coordinator.submitBatch({
      eventId: event.id,
      reactions: [{ username: 'bot-one', message: 'сообщение от старой личности' }],
    });
    expect(accepted.accepted).toHaveLength(1);
    setCandidates([bot('bot-one', 3), bot('bot-two', 1), bot('bot-three', 2)]);
    await vi.runAllTimersAsync();
    expect(sent).toEqual([]);
    await coordinator.stop();
  });
});

/**
 * The same wiring `setup()` above uses, but driven by a real StreamSession rather than a boolean
 * fake — this is what actually proves the coordinator's cold-start bookkeeping (the age recorded
 * for the first send, and the per-mechanism decision counts) matches what a real session clock
 * produces, rather than just matching whatever the fake was told to say.
 */
async function liveSessionSetup(now: () => number) {
  const streamSession = new StreamSession({ now, coldStartWindowMs: 60_000, newId: () => 'session-1' });
  streamSession.begin();
  const repository = new MemoryRepository();
  await repository.initialize();
  const history = new BotHistory(repository);
  const personaMemory = new PersonaMemory(repository, { now });
  const personaRuntime = new PersonaRuntimeStore(now);
  const contextStore = new ContextStore({ chatWindowMs: 120_000, maxChatMessages: 100, maxEvents: 100, now });
  contextStore.configure({ channel: 'streamer', category: 'Dota 2', streamContext: 'рейтинг с друзьями' });
  let candidates = [bot('bot-one', 0), bot('bot-two', 1), bot('bot-three', 2)];
  const sent: Array<{ username: string; message: string }> = [];
  const usage = new UsageTracker();
  const globalMemory = new GlobalStreamerMemory({ repository, usage, now });
  await globalMemory.startOrResumeSession({ channel: 'streamer', initialCategory: 'Dota 2' });
  const policy = new ReactionPolicyGuard({
    globalMessagesPer30Seconds: 20, maxReactionsPerEvent: 3, reactionShareOfCandidates: 1, now,
  });
  const written: Array<Record<string, unknown>> = [];
  vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
    if (typeof line === 'string') {
      try { written.push(JSON.parse(line) as Record<string, unknown>); } catch { /* not ours */ }
    }
  });
  const coordinator = new ReactionCoordinator({
    policy,
    naturalness: new NaturalnessGuard(),
    coldStart: () => streamSession.coldStartStatus(),
    onMessageSent: () => streamSession.markMessageSent(),
    sender: { send: async (username, message) => { sent.push({ username, message }); return { submitted: true, submittedAt: now() }; } },
    history,
    memory: new ReactionMemory({ enabled: true, reactionWindowMs: 1_000, repository }),
    globalMemory,
    personaContext: new PersonaContextBuilder(personaMemory, personaRuntime),
    personaMemory,
    personaRuntime,
    contextStore,
    usage,
    logger: new Logger('TEST', 'info'),
    retrievalLimit: 4,
    candidates: () => candidates,
    contextTtlMs: 60_000,
    now,
  });
  return {
    coordinator, streamSession, sent, logged: () => written,
    setCandidates: (value: ReactionBotCandidate[]) => { candidates = value; },
  };
}

describe('cold-start bookkeeping against a real StreamSession clock', () => {
  it('records how old the session was when the first message actually landed', async () => {
    vi.useFakeTimers();
    let clock = event.timestamp;
    const now = () => clock;
    const { coordinator, sent, logged } = await liveSessionSetup(now);

    clock += 41_000; // 41 seconds into the strict window
    await coordinator.prepareBrainEvent({ ...event, id: 'e1' }, 0);
    await coordinator.submitBatch({ eventId: 'e1', reactions: [{ username: 'bot-one', message: 'ого' }] });
    await vi.runAllTimersAsync();
    expect(sent).toHaveLength(1);

    coordinator.logSessionSummary('test');
    const summary = logged().find((entry) => entry.message === 'Stream decision summary');
    expect(summary).toMatchObject({ firstAiMessageAtMs: 41_000, coldStartWindowExpired: false });
    await coordinator.stop();
    vi.restoreAllMocks();
  });

  it('counts stream-event decisions taken under the strict bar separately from ordinary ones', async () => {
    vi.useFakeTimers();
    let clock = event.timestamp;
    const now = () => clock;
    const { coordinator, logged } = await liveSessionSetup(now);

    // Two silent decisions inside the 60-second window.
    await coordinator.prepareBrainEvent({ ...event, id: 'cold-1' }, 0);
    await coordinator.submitBatch({ eventId: 'cold-1', reactions: [] });
    clock += 20_000;
    await coordinator.prepareBrainEvent({ ...event, id: 'cold-2' }, 0);
    await coordinator.submitBatch({ eventId: 'cold-2', reactions: [] });

    // Past the window: an ordinary decision, no longer under the bar.
    clock += 45_000; // total age now 65s
    await coordinator.prepareBrainEvent({ ...event, id: 'warm-1' }, 0);
    await coordinator.submitBatch({ eventId: 'warm-1', reactions: [] });

    coordinator.logSessionSummary('test');
    const summary = logged().find((entry) => entry.message === 'Stream decision summary');
    expect(summary).toMatchObject({
      streamEventDecisions: 3,
      streamDecisionsDuringColdStart: 2,
      coldStartWindowExpired: true,
    });
    expect(summary?.firstAiMessageAtMs).toBeUndefined();
    await coordinator.stop();
    vi.restoreAllMocks();
  });

  it('does not let a naturalness-rejected candidate count as the first message', async () => {
    // A candidate that never reaches Twitch has not introduced these accounts to anybody, whether
    // the reason is a failed send or the naturalness guard deciding it was commentary rather than a
    // reaction. Both must leave the strict bar exactly where they found it.
    vi.useFakeTimers();
    let clock = event.timestamp;
    const now = () => clock;
    const { coordinator, streamSession, sent } = await liveSessionSetup(now);

    clock += 10_000;
    await coordinator.prepareBrainEvent({
      ...event,
      id: 'rejected-1',
      speech: 'O: I support Yandex. S: Yandex so good.',
      summary: 'O: I support Yandex. S: Yandex so good.',
    }, 0);
    const result = await coordinator.submitBatch({
      eventId: 'rejected-1',
      reactions: [{ username: 'bot-one', message: 'Яндекс это мощно конечно' }],
    });
    expect(result.rejected).toEqual([{ username: 'bot-one', reason: 'generic_evaluator' }]);
    expect(sent).toEqual([]);
    expect(streamSession.snapshot()?.hasSentAiMessage).toBe(false);
    expect(streamSession.isStrictColdStart()).toBe(true);
    await coordinator.stop();
  });
});
