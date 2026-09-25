import { describe, expect, it } from 'vitest';
import { MemoryRepository } from '../src/persistence/memory-repository';
import { LearnedPolicyRule } from '../src/learning/learned-policy.types';

describe('durable verdict revisions', () => {
  it('queues only the corrected verdict and withdraws rules based on the old rating', async () => {
    const repository = new MemoryRepository();
    const original = { id: 'old', createdAt: 1000, username: 'bot', message: 'пример', verdict: 'bad' as const, reactionId: 'reaction' };
    await repository.saveMessageVerdict(original);
    const rule: LearnedPolicyRule = {
      id: 'rule', scopeType: 'global', scopeKey: '', rule: 'правило', rationale: '', confidence: 0.9,
      supportCount: 1, negativeEvidence: 1, positiveEvidence: 0, evidenceIds: ['old'], status: 'active',
      teacherModel: 'test', createdAt: 1000, updatedAt: 1000, version: 1,
    };
    await repository.applyLearnedPolicyBatch({ upserts: [rule], processedVerdictIds: ['old'], processedAt: 1001 });
    await repository.saveMessageVerdict({ ...original, id: 'new', createdAt: 2000, verdict: 'good' });
    expect((await repository.listMessageVerdicts(100)).map((v) => v.id)).toEqual(['new']);
    expect((await repository.listUnprocessedMessageVerdicts(100)).map((v) => v.id)).toEqual(['new']);
    expect((await repository.listLearnedPolicyRules())[0]).toMatchObject({ confidence: 0, evidenceIds: [], supportCount: 0, negativeEvidence: 0 });
  });

  it('rejects a model result if its input was replaced during generation', async () => {
    const repository = new MemoryRepository();
    const original = { id: 'old', createdAt: 1000, username: 'bot', message: 'пример', verdict: 'bad' as const, reactionId: 'reaction' };
    await repository.saveMessageVerdict(original);
    await repository.saveMessageVerdict({ ...original, id: 'new', createdAt: 2000, verdict: 'good' });
    await expect(repository.applyLearnedPolicyBatch({ upserts: [], processedVerdictIds: ['old'], processedAt: 3000 })).rejects.toThrow('stale');
    expect((await repository.listUnprocessedMessageVerdicts(100)).map((v) => v.id)).toEqual(['new']);
  });
});
