import { describe, expect, it, vi } from 'vitest';
import { GlobalStreamerMemory } from '../src/global-memory/global-streamer-memory';
import { ReactionMemory } from '../src/learning/reaction-memory';
import { Logger } from '../src/logger';
import { BotHistory } from '../src/personas/bot-history';
import { generatePersonaV3 } from '../src/personas/generator-v3';
import { PersonaContextBuilder } from '../src/personas/persona-context-builder';
import { PersonaMemory } from '../src/personas/persona-memory';
import { PersonaMindRecord, PersonaMindStore } from '../src/personas/persona-mind';
import { PersonaRuntimeStore } from '../src/personas/persona-runtime-store';
import { MemoryRepository } from '../src/persistence/memory-repository';
import { NaturalnessGuard } from '../src/reaction/naturalness-guard';
import { ReactionCoordinator } from '../src/reaction/reaction-coordinator';
import { ReactionPolicyGuard } from '../src/reaction/reaction-policy-guard';
import { ReactionBotCandidate } from '../src/reaction/types';
import { ContextStore } from '../src/stream-brain/context-store';
import { StreamEvent } from '../src/stream-brain/types';
import { UsageTracker } from '../src/usage/usage-tracker';

/**
 * The offline eval harness the Living Persona work is judged against: one real event, three real
 * personas whose minds differ, one real coordinator — and the structured decision input it would
 * send, inspected without any paid call. The Brain itself is the one stochastic piece, so what is
 * validated here is everything up to it (whose life reaches the payload and why) and everything
 * after it (that a mocked decision's motive/source parse and land in the audit trail).
 */

const NOW = 1_700_000_000_000;
const logger = new Logger('TEST', 'error');

const SHANGHAI_EVENT: StreamEvent = {
  id: 'event-shanghai', timestamp: NOW, type: 'conversation',
  summary: 'S: стример обсуждает квартиру в Шанхае, аренда жилья и цены',
  speech: 'S: стример обсуждает квартиру в Шанхае, аренда жилья и цены',
  importance: 0.7, confidence: 0.9, source: 'transcription', directMentions: [],
};

function mindFor(username: string, overrides: Partial<PersonaMindRecord>): PersonaMindRecord {
  return {
    personaId: `account-${username}`, username, seedVersion: 1,
    knowledge: [], curiosities: [], openLoops: [], life: [], people: [],
    moment: { mood: 'спокойное настроение', energy: 0.7, attention: 'watching', updatedAt: NOW },
    createdAt: NOW, updatedAt: NOW, ...overrides,
  };
}

async function evalHarness() {
  const repository = new MemoryRepository();
  await repository.initialize();
  const usage = new UsageTracker();
  const personaMemory = new PersonaMemory(repository, { now: () => NOW });
  const personaRuntime = new PersonaRuntimeStore(() => NOW);
  const contextStore = new ContextStore({ chatWindowMs: 120_000, maxChatMessages: 100, maxEvents: 100, now: () => NOW });
  contextStore.configure({ channel: 'streamer', category: 'IRL', streamContext: 'поездка в Китай' });
  const globalMemory = new GlobalStreamerMemory({ repository, usage, now: () => NOW });
  await globalMemory.startOrResumeSession({ channel: 'streamer', initialCategory: 'IRL' });

  // Three real catalog personas; what differs is their MINDS, not a style preset.
  const usernames = ['karlbekner', 'gigantiuz', 'supercser2'] as const;
  const candidates: ReactionBotCandidate[] = usernames.map((username) => ({
    username,
    persona: generatePersonaV3(username),
    enabled: true, connectionState: 'CONNECTED', chatConnected: true,
  }));

  const minds = [
    // The remote worker who has been thinking about living abroad and has no idea what rent costs.
    mindFor('karlbekner', {
      life: [{ id: 'l1', concern: 'думает про переезд и жизнь за границей', kind: 'plan', stage: 'active', salience: 0.85, startedAt: NOW, updatedAt: NOW }],
      curiosities: [{ id: 'c1', topic: 'аренда жилья за границей', question: 'сколько реально стоит аренда квартиры в Шанхае', status: 'open', strength: 0.9, createdAt: NOW, updatedAt: NOW }],
      knowledge: [{ topic: 'Китай', state: 'unknown', updatedAt: NOW }],
    }),
    // The local with a busy week who does not care about travel at all.
    mindFor('gigantiuz', {
      life: [{ id: 'l1', concern: 'на работе завал', kind: 'work', stage: 'active', salience: 0.7, startedAt: NOW, updatedAt: NOW }],
      knowledge: [{ topic: 'сервера и железо', state: 'knows_well', updatedAt: NOW }],
      moment: { mood: 'устал после работы', energy: 0.4, attention: 'half_watching', updatedAt: NOW },
    }),
    // The bureaucracy-curious one.
    mindFor('supercser2', {
      curiosities: [{ id: 'c1', topic: 'оформление аренды жилья иностранцу и визы', question: 'может ли иностранец вообще снять квартиру без местных документов', status: 'open', strength: 0.8, createdAt: NOW, updatedAt: NOW }],
    }),
  ];
  const mindRepository = new MemoryRepository();
  await mindRepository.initialize();
  for (const record of minds) await mindRepository.savePersonaMind(record);
  const mind = new PersonaMindStore(mindRepository, logger, () => NOW);
  await mind.load();

  const coordinator = new ReactionCoordinator({
    policy: new ReactionPolicyGuard({ globalMessagesPer30Seconds: 10, maxReactionsPerEvent: 3, reactionShareOfCandidates: 1, now: () => NOW }),
    naturalness: new NaturalnessGuard(),
    mind,
    sender: { send: async () => ({ submitted: true, submittedAt: NOW }) },
    history: new BotHistory(repository),
    memory: new ReactionMemory({ enabled: false, reactionWindowMs: 1_000, repository }),
    globalMemory,
    personaContext: new PersonaContextBuilder(personaMemory, personaRuntime),
    personaMemory,
    personaRuntime,
    contextStore,
    usage,
    logger,
    retrievalLimit: 3,
    candidates: () => candidates,
    now: () => NOW,
  });
  return { coordinator, mind };
}

describe('living persona eval — same event, three different humans', () => {
  it('produces three different personal framings of one moment, from state rather than style', async () => {
    const { coordinator } = await evalHarness();
    const prepared = await coordinator.prepareBrainEvent(SHANGHAI_EVENT, 0);

    const byPersona = prepared.mindContext?.byPersona ?? {};
    // The remote worker arrives with his own open question — the reason a rent question would be
    // HIS. (His broader relocation concern shares no surface token with this event's wording, so
    // retrieval honestly leaves it out; the curiosity is the part that connects.)
    expect(byPersona.karlbekner?.join(' ')).toContain('аренда квартиры в Шанхае');
    // The visa-curious one arrives with a different question the stream never asked.
    expect(byPersona.supercser2?.join(' ')).toContain('иностранец');
    // The tired local has no personal connection to Shanghai rent and carries nothing here —
    // his plausible silence is represented by absence, not by an instruction.
    expect(byPersona.gigantiuz).toBeUndefined();

    // Payload discipline: slices are lines, not biographies. No identity, no message examples,
    // no full knowledge dumps — the canon still travels only through the bootstrap.
    const serialized = JSON.stringify(prepared.mindContext);
    expect(serialized).not.toContain('Кокшетау');
    expect(serialized.length).toBeLessThan(2_200);
    await coordinator.stop();
  });

  it('accepts a mocked decision whose question is traceable to the knowledge gap that produced it', async () => {
    const { coordinator, mind } = await evalHarness();
    await coordinator.prepareBrainEvent(SHANGHAI_EVENT, 0);
    const result = await coordinator.submitBatch({
      eventId: SHANGHAI_EVENT.id,
      reactions: [{
        username: 'karlbekner',
        message: 'а сколько там хата в месяц выходит?',
        motive: 'ask', sourceType: 'knowledge_gap', sourceRef: 'аренда жилья за границей',
      }],
    });
    expect(result.accepted.map((item) => item.username)).toEqual(['karlbekner']);
    // The operator-facing answer to "why did THIS viewer want to know": the audit trail holds the
    // structured origin, and nothing anywhere holds hidden reasoning prose.
    expect(mind.lastMotives('karlbekner')[0]).toMatchObject({
      motive: 'ask', sourceType: 'knowledge_gap', sourceRef: 'аренда жилья за границей',
    });
    await coordinator.stop();
    vi.restoreAllMocks();
  });
});
