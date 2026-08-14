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

async function setup(senderResult = true) {
  const repository = new MemoryRepository();
  await repository.initialize();
  const history = new BotHistory(repository);
  const personaMemory = new PersonaMemory(repository, { now: () => event.timestamp });
  const personaRuntime = new PersonaRuntimeStore(() => event.timestamp);
  const contextStore = new ContextStore({ chatWindowMs: 120_000, maxChatMessages: 100, maxEvents: 100, now: () => event.timestamp });
  contextStore.configure({ channel: 'streamer', category: 'Dota 2', streamContext: 'рейтинг с друзьями' });
  contextStore.addChat({
    id: 'chat-1', timestamp: event.timestamp, username: 'viewer', displayName: 'Viewer',
    message: '@bot-two ну что скажешь?', kind: 'viewer',
  });
  let candidates = [bot('bot-one', 0), bot('bot-two', 1), bot('bot-three', 2)];
  const sent: Array<{ username: string; message: string }> = [];
  const usage = new UsageTracker();
  const globalMemory = new GlobalStreamerMemory({ repository, usage, now: () => event.timestamp });
  await globalMemory.startOrResumeSession({ channel: 'streamer', initialCategory: 'Dota 2' });
  const policy = new ReactionPolicyGuard({
    minimumDelayMs: 100,
    maximumDelayMs: 300,
    globalMessagesPer30Seconds: 2,
    maxReactionsPerEvent: 3,
    now: () => event.timestamp,
    random: () => 0,
  });
  const coordinator = new ReactionCoordinator({
    policy,
    sender: { send: async (username, message) => { sent.push({ username, message }); return senderResult; } },
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
    now: () => event.timestamp,
  });
  return { coordinator, globalMemory, history, policy, sent, usage, setCandidates: (value: ReactionBotCandidate[]) => { candidates = value; } };
}

afterEach(() => vi.useRealTimers());

describe('single-session reaction protocol', () => {
  it('supplies relevant channel memory once at the reaction root instead of cloning it into every persona', async () => {
    const { coordinator, globalMemory } = await setup();
    await globalMemory.recordFromGemini({
      memories: [{
        type: 'important_event', summary: 'Стример промахнулся решающим ультимейтом.',
        entities: ['ультимейт'], tags: ['Dota 2'], importance: .9, confidence: .95,
      }],
    });

    const prepared = await coordinator.prepare(event);

    expect(prepared.globalStreamerMemories).toEqual([
      expect.objectContaining({ type: 'important_event', summary: expect.stringContaining('ультимейтом') }),
    ]);
    expect(prepared.candidates).not.toEqual([]);
    expect(prepared.candidates.every((candidate) => !('globalStreamerMemories' in candidate))).toBe(true);
    expect(prepared.constraints.instructions.join('\n')).toContain('descriptive style evidence, never response templates');
    expect(prepared.constraints.instructions.join('\n')).toContain('not a caption to paraphrase');
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
      const prepared = await coordinator.prepare(classifiedEvent);
      expect(prepared.candidates).toHaveLength(1);
      expect(prepared.candidates[0]?.accountClassificationQuestion).toBe(true);
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
    await coordinator.prepare(leakEvent);
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
    await coordinator.prepare(externalAiEvent);
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
      await coordinator.prepare(disclosureEvent);
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
      await coordinator.prepare(internalEvent);
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
    const prepared = await coordinator.prepare(directEvent);

    expect(prepared.eventId).toBe(directEvent.id);
    expect(prepared.recentChat[0]).toMatchObject({ username: 'viewer' });
    expect(prepared.candidates.map((candidate) => candidate.username)).toEqual(['bot-two']);
    expect(prepared.candidates[0]?.directMention).toBe(true);
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

  it('supplies all four eligible bots for an ordinary event', async () => {
    const { coordinator, setCandidates } = await setup();
    setCandidates([
      bot('bot-one', 0), bot('bot-two', 1), bot('bot-three', 2), bot('bot-four', 3),
    ]);

    const prepared = await coordinator.prepare({ ...event, id: 'four-candidates' });

    expect(prepared.candidates.map((candidate) => candidate.username)).toEqual([
      'bot-one', 'bot-two', 'bot-three', 'bot-four',
    ]);
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

    const prepared = await coordinator.prepare(directEvent);

    expect(prepared.candidates).toEqual([]);
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
    const { coordinator, sent } = await setup();
    const traces: ReactionTraceRecord[] = [];
    coordinator.on('trace', (trace: ReactionTraceRecord) => traces.push(trace));
    await coordinator.prepare(event);
    const result = await coordinator.submitBatch({
      eventId: event.id,
      reactions: [{ username: 'bot-three', message: 'это был ульт в параллельную вселенную' }],
    });

    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0]).toMatchObject({ username: 'bot-three' });
    expect(result.accepted[0]?.delayMs).toBeGreaterThan(0);
    expect(sent).toEqual([]);
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
    });
    await coordinator.stop();
  });

  it('accepts an empty reaction batch as a natural no-response decision', async () => {
    const { coordinator, sent, usage } = await setup();
    await coordinator.prepare(event);
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
    await coordinator.prepare(failedEvent);
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
      sendFailed: [{ username: 'bot-one', reason: 'twitch_sender_returned_false' }],
    });
    await coordinator.stop();
  });

  it('rejects duplicate usernames and disconnected accounts without cancelling valid items', async () => {
    vi.useFakeTimers();
    const { coordinator, sent, setCandidates } = await setup();
    await coordinator.prepare(event);
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
    await coordinator.prepare(exactEvent);

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
    await coordinator.prepare(event);
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
      event,
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
    await coordinator.prepare(event);
    await coordinator.submitBatch({ eventId: event.id, reactions: [] });
    const replay = await coordinator.submitBatch({ eventId: event.id, reactions: [] });
    expect(replay).toMatchObject({ eventId: event.id, accepted: [], stale: true });
    await coordinator.stop();
  });

  it('cancels a queued message when the account persona changes before send', async () => {
    vi.useFakeTimers();
    const { coordinator, sent, setCandidates } = await setup();
    await coordinator.prepare(event);
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
