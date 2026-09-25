import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresRepository } from '../src/persistence/postgres-repository';
import { PersonaMemory } from '../src/personas/persona-memory';
import { generatePersonaV3 } from '../src/personas/generator-v3';
import { LearnedPolicyRule } from '../src/learning/learned-policy.types';

// Explicit opt-in, local disposable database only. Never load the application's DATABASE_URL.
const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)('Postgres learning and memory integrity', () => {
  let repository: PostgresRepository;
  beforeAll(async () => {
    if (!url || new URL(url).hostname !== '127.0.0.1') throw new Error('Use a disposable local database');
    repository = new PostgresRepository(url, false);
    await repository.initialize();
    await repository.initialize(); // migration replay is safe
  }, 30_000);
  afterAll(async () => { await repository?.close(); });

  it('isolates persisted memories and dialogue before applying limits', async () => {
    const persona = generatePersonaV3('karlbekner');
    persona.id = randomUUID();
    persona.relationships = [];
    await repository.upsertPersona(persona);
    let channel = 'first';
    const memory = new PersonaMemory(repository, { channel: () => channel });
    await memory.remember({ personaId: persona.id, type: 'streamer', summary: 'любит шахматы', importance: 0.9, tags: [] });
    await memory.addConversation({ personaId: persona.id, viewerUsername: 'viewer', role: 'viewer', message: 'шахматы?' });
    channel = 'second';
    expect(await memory.retrieve(persona.id, 'шахматы')).toEqual([]);
    expect(await memory.conversation(persona.id, 'viewer')).toEqual([]);
    expect(await memory.recentConversationPersonaIds('viewer')).toEqual([]);
    channel = 'first';
    expect((await memory.retrieve(persona.id, 'шахматы'))[0]?.channel).toBe('first');
    expect((await memory.conversation(persona.id, 'viewer'))[0]?.channel).toBe('first');
  });

  it('retains one current revision, withdraws old evidence, and rejects stale Teacher commits', async () => {
    const old = { id: randomUUID(), createdAt: Date.now(), username: 'bot', message: 'пример', verdict: 'bad' as const, reactionId: randomUUID() };
    await repository.saveMessageVerdict(old);
    const rule: LearnedPolicyRule = {
      id: randomUUID(), scopeType: 'global', scopeKey: '', rule: 'правило', rationale: '', confidence: 0.9,
      supportCount: 1, negativeEvidence: 1, positiveEvidence: 0, evidenceIds: [old.id], status: 'active',
      teacherModel: 'test', createdAt: old.createdAt, updatedAt: old.createdAt, version: 1,
    };
    await repository.applyLearnedPolicyBatch({ upserts: [rule], processedVerdictIds: [old.id], processedAt: Date.now() });
    const corrected = { ...old, id: randomUUID(), createdAt: Date.now() + 1, verdict: 'good' as const };
    await repository.saveMessageVerdict(corrected);
    expect((await repository.listMessageVerdicts(100)).filter((v) => v.reactionId === old.reactionId).map((v) => v.id)).toEqual([corrected.id]);
    expect((await repository.listLearnedPolicyRules()).find((r) => r.id === rule.id)).toMatchObject({ confidence: 0, supportCount: 0, evidenceIds: [], negativeEvidence: 0 });
    await expect(repository.applyLearnedPolicyBatch({ upserts: [rule], processedVerdictIds: [old.id], processedAt: Date.now() })).rejects.toThrow('stale');
    expect((await repository.listUnprocessedMessageVerdicts(100)).some((v) => v.id === corrected.id)).toBe(true);
  });

  it('serializes concurrent corrections without two active verdicts', async () => {
    const reactionId = randomUUID();
    await Promise.all(['good', 'bad', 'good'].map((verdict) => repository.saveMessageVerdict({
      id: randomUUID(), createdAt: Date.now(), username: 'bot', message: 'сообщение', reactionId, verdict: verdict as 'good' | 'bad',
    })));
    expect((await repository.listMessageVerdicts(100)).filter((v) => v.reactionId === reactionId)).toHaveLength(1);
  });
});
