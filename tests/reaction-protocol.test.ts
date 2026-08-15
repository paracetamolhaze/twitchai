import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReactionMemory } from '../src/learning/reaction-memory';
import { GlobalStreamerMemory } from '../src/global-memory/global-streamer-memory';
import { Logger } from '../src/logger';
import { BotHistory } from '../src/personas/bot-history';
import { PersonaContextBuilder } from '../src/personas/persona-context-builder';
import { PersonaMemory } from '../src/personas/persona-memory';
import { PersonaRuntimeStore } from '../src/personas/persona-runtime-store';
import { generatePersonaV3 } from '../src/personas/generator-v3';
import { MemoryRepository } from '../src/persistence/memory-repository';
import { ReactionCoordinator } from '../src/reaction/reaction-coordinator';
import { ReactionPolicyGuard } from '../src/reaction/reaction-policy-guard';
import { ReactionBotCandidate, ReactionTraceRecord } from '../src/reaction/types';
import { ContextStore } from '../src/stream-brain/context-store';
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

async function setup(senderResult: SenderResult = true, now: () => number = () => event.timestamp) {
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
  const sent: Array<{ username: string; message: string }> = [];
  const usage = new UsageTracker();
  const globalMemory = new GlobalStreamerMemory({ repository, usage, now });
  await globalMemory.startOrResumeSession({ channel: 'streamer', initialCategory: 'Dota 2' });
  const policy = new ReactionPolicyGuard({
    globalMessagesPer30Seconds: 2,
    maxReactionsPerEvent: 3,
    now,
  });
  const coordinator = new ReactionCoordinator({
    policy,
    sender: {
      send: async (username, message) => {
        sent.push({ username, message });
        const accepted = await (typeof senderResult === 'function' ? senderResult(username, message) : senderResult);
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
    logger: new Logger('TEST', 'error'),
    retrievalLimit: 4,
    candidates: () => candidates,
    contextTtlMs: 60_000,
    now,
  });
  return { coordinator, globalMemory, history, policy, sent, usage, setCandidates: (value: ReactionBotCandidate[]) => { candidates = value; } };
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
    expect(JSON.stringify(prepared)).not.toContain('Стример промахнулся решающим ультимейтом.');
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
