import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReactionMemory } from '../src/learning/reaction-memory';
import { Logger } from '../src/logger';
import { BotHistory } from '../src/personas/bot-history';
import { PersonaContextBuilder } from '../src/personas/persona-context-builder';
import { PersonaMemory } from '../src/personas/persona-memory';
import { PersonaRuntimeStore } from '../src/personas/persona-runtime-store';
import { DEFAULT_PERSONAS } from '../src/personas/defaults';
import { MemoryRepository } from '../src/persistence/memory-repository';
import { ReactionCoordinator } from '../src/reaction/reaction-coordinator';
import { ReactionPolicyGuard } from '../src/reaction/reaction-policy-guard';
import { ReactionBotCandidate } from '../src/reaction/types';
import { ContextStore } from '../src/stream-brain/context-store';
import { StreamEvent } from '../src/stream-brain/types';
import { UsageTracker } from '../src/usage/usage-tracker';

const event: StreamEvent = {
  id: 'event-1', timestamp: 1_700_000_000_000, type: 'fail',
  summary: 'стример промахнулся решающим ультимейтом', importance: 0.92,
  confidence: 0.96, source: 'gemini-live', directMentions: [],
};

function bot(username: string, index: number): ReactionBotCandidate {
  return {
    username,
    persona: {
      ...DEFAULT_PERSONAS[index]!,
      behavior: { ...DEFAULT_PERSONAS[index]!.behavior, minimumIntervalMs: 30_000 },
    },
    enabled: true,
    connectionState: 'CONNECTED',
    chatConnected: true,
  };
}

async function setup() {
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
    sender: { send: async (username, message) => { sent.push({ username, message }); return true; } },
    history,
    memory: new ReactionMemory({ enabled: true, reactionWindowMs: 1_000, repository }),
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
  return { coordinator, history, policy, sent, usage, setCandidates: (value: ReactionBotCandidate[]) => { candidates = value; } };
}

afterEach(() => vi.useRealTimers());

describe('single-session reaction protocol', () => {
  it('limits a direct question to exactly the addressed persona', async () => {
    const { coordinator } = await setup();
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
    await coordinator.stop();
  });

  it('schedules exactly the usernames and final messages selected by Gemini', async () => {
    vi.useFakeTimers();
    const { coordinator, sent } = await setup();
    await coordinator.prepare(event);
    const result = await coordinator.submitBatch({
      eventId: event.id,
      reactions: [{ username: 'bot-three', message: 'это был ульт в параллельную вселенную' }],
    });

    expect(result.accepted).toEqual([{ username: 'bot-three', delayMs: 100 }]);
    expect(sent).toEqual([]);
    await vi.runAllTimersAsync();
    expect(sent).toEqual([{ username: 'bot-three', message: 'это был ульт в параллельную вселенную' }]);
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
