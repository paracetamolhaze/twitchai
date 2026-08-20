import { describe, expect, it } from 'vitest';
import { LearnedPolicyStore } from '../src/learning/learned-policy-store';
import { LearnedPolicyRule } from '../src/learning/learned-policy.types';
import { Logger } from '../src/logger';
import { MemoryRepository } from '../src/persistence/memory-repository';
import { StreamEvent } from '../src/stream-brain/types';

const logger = new Logger('TEST', 'error');

function rule(overrides: Partial<LearnedPolicyRule> & { id: string }): LearnedPolicyRule {
  return {
    scopeType: 'global', scopeKey: '', rule: 'Some standing rule.', rationale: 'because',
    confidence: 0.8, supportCount: 2, positiveEvidence: 0, negativeEvidence: 2, status: 'active',
    teacherModel: 'test/teacher', evidenceIds: [], createdAt: 1_000, updatedAt: 1_000, version: 1,
    ...overrides,
  };
}

function streamEvent(overrides: Partial<StreamEvent> = {}): StreamEvent {
  return {
    id: 'event-1', timestamp: 1_700_000_000_000, type: 'conversation',
    summary: 'O: это камбэк сейчас будет, все на низ бежим',
    speech: 'O: это камбэк сейчас будет, все на низ бежим',
    importance: 0.6, confidence: 0.9, source: 'transcription', directMentions: [], ...overrides,
  };
}

async function storeWith(rules: LearnedPolicyRule[]) {
  const repository = new MemoryRepository();
  await repository.initialize();
  await repository.applyLearnedPolicyBatch({ upserts: rules, processedVerdictIds: [], processedAt: 1_000 });
  const store = new LearnedPolicyStore(repository, logger);
  await store.load();
  return { store, repository };
}

describe('learned policy retrieval for one decision', () => {
  it('attaches a global rule to an ordinary decision', async () => {
    const { store } = await storeWith([rule({
      id: 'r1', rule: 'Do not repeat a conclusion the speakers have already reached.',
    })]);
    const policy = store.forDecision(streamEvent(), ['griffin0502']);
    expect(policy?.global).toEqual(['Do not repeat a conclusion the speakers have already reached.']);
  });

  it('returns nothing at all when no rule exists, rather than an empty block', async () => {
    const { store } = await storeWith([]);
    expect(store.forDecision(streamEvent(), ['griffin0502'])).toBeUndefined();
  });

  it('attaches a persona rule only to the account it belongs to, keyed so scope cannot be misread', async () => {
    const { store } = await storeWith([rule({
      id: 'r1', scopeType: 'persona', scopeKey: 'supercser2',
      rule: 'supercser2 must not give confident Dota advice.',
    })]);
    const included = store.forDecision(streamEvent(), ['supercser2', 'griffin0502']);
    expect(included?.byPersona).toEqual({ supercser2: ['supercser2 must not give confident Dota advice.'] });
    expect(included?.global).toEqual([]);

    // A decision that does not shortlist supercser2 must not carry its rule at all.
    const excluded = store.forDecision(streamEvent(), ['griffin0502', 'ya_yebalo']);
    expect(excluded).toBeUndefined();
  });

  it('I. never sends a rule the operator disabled in the dashboard', async () => {
    const { store } = await storeWith([rule({ id: 'r1', rule: 'A rule about something.' })]);
    expect(store.forDecision(streamEvent(), ['griffin0502'])?.global).toHaveLength(1);
    await store.setStatus('r1', 'disabled');
    expect(store.forDecision(streamEvent(), ['griffin0502'])).toBeUndefined();
  });

  it('never sends a rule the Teacher superseded either', async () => {
    const { store } = await storeWith([rule({ id: 'r1', status: 'superseded' })]);
    expect(store.forDecision(streamEvent(), ['griffin0502'])).toBeUndefined();
  });

  it('J. a rule created mid-stream reaches the next decision with no restart', async () => {
    const { store, repository } = await storeWith([]);
    expect(store.forDecision(streamEvent(), ['griffin0502'])).toBeUndefined();
    // Exactly what a Teacher run does: write through the store, which reloads from storage.
    await store.apply([rule({ id: 'fresh', rule: 'A rule learned while the stream was live.' })], [], 2_000);
    expect(store.forDecision(streamEvent(), ['griffin0502'])?.global)
      .toEqual(['A rule learned while the stream was live.']);
    expect(await repository.listLearnedPolicyRules()).toHaveLength(1);
  });

  it('holds back a rule the Teacher was not confident about', async () => {
    const { store } = await storeWith([rule({ id: 'r1', confidence: 0.3 })]);
    expect(store.forDecision(streamEvent(), ['griffin0502'])).toBeUndefined();
  });

  it('attaches a topic rule when the moment matches it and not when it does not', async () => {
    const { store } = await storeWith([rule({
      id: 'r1', scopeType: 'topic', scopeKey: 'камбэк отыгрыш',
      rule: 'During a comeback push, do not announce the comeback the players just announced.',
    })]);
    expect(store.forDecision(streamEvent(), ['griffin0502'])?.topic).toHaveLength(1);

    const unrelated = streamEvent({
      id: 'event-2', type: 'visual', summary: 'стример роняет кружку с чаем на клавиатуру',
      speech: 'стример роняет кружку с чаем на клавиатуру',
    });
    expect(store.forDecision(unrelated, ['griffin0502'])?.topic ?? []).toHaveLength(0);
  });

  it('caps how much policy one decision may carry, highest confidence first', async () => {
    const many = Array.from({ length: 8 }, (_, index) => rule({
      id: `r${index}`, rule: `Global rule number ${index}.`, confidence: 0.5 + index / 100,
    }));
    const { store } = await storeWith(many);
    const policy = store.forDecision(streamEvent(), ['griffin0502']);
    expect(policy?.global).toHaveLength(3);
    // Ordered by confidence, so the three strongest are the ones that got the slots.
    expect(policy?.global[0]).toBe('Global rule number 7.');
  });

  it('caps persona rules across all candidates, not just per account', async () => {
    const rules = ['a', 'b', 'c', 'd', 'e'].map((name) => rule({
      id: `r-${name}`, scopeType: 'persona', scopeKey: name, rule: `${name} should stop doing that.`,
    }));
    const { store } = await storeWith(rules);
    const policy = store.forDecision(streamEvent(), ['a', 'b', 'c', 'd', 'e']);
    expect(Object.keys(policy?.byPersona ?? {})).toHaveLength(3);
  });

  it('reports which rules were supplied, for the decision log rather than for the model', async () => {
    const { store } = await storeWith([
      rule({ id: 'r-global' }),
      rule({ id: 'r-persona', scopeType: 'persona', scopeKey: 'griffin0502', rule: 'griffin0502 rule.' }),
    ]);
    const policy = store.forDecision(streamEvent(), ['griffin0502']);
    expect(policy?.supplied.map((item) => item.id).sort()).toEqual(['r-global', 'r-persona']);
    expect(policy?.supplied.map((item) => item.scope).sort()).toEqual(['global', 'persona']);
  });

  it('keeps the attached policy inside a measured character budget', async () => {
    // The worst realistic case: every scope full, each rule at the length the Teacher is capped to.
    const longRule = 'x'.repeat(220);
    const { store } = await storeWith([
      ...Array.from({ length: 3 }, (_, index) => rule({ id: `g${index}`, rule: longRule, confidence: 0.9 })),
      rule({ id: 't1', scopeType: 'topic', scopeKey: 'камбэк', rule: longRule }),
      ...['a', 'b', 'c'].map((name) => rule({ id: `p-${name}`, scopeType: 'persona', scopeKey: name, rule: longRule })),
    ]);
    const policy = store.forDecision(streamEvent(), ['a', 'b', 'c']);
    const characters = JSON.stringify(policy && {
      guidance: policy.guidance, global: policy.global, topic: policy.topic, byPersona: policy.byPersona,
    }).length;
    // Roughly 2.2k characters at the absolute ceiling — a few hundred tokens against a decision
    // payload that already runs 10-20k. The point of the assertion is that it cannot grow silently.
    expect(characters).toBeLessThan(2_500);
  });

  it('counts rules only for scopes that actually reached a decision', async () => {
    const { store } = await storeWith([rule({ id: 'r1' })]);
    expect(store.snapshot()).toMatchObject({ activeRules: 1, rulesSupplied: 0, decisionsWithPolicy: 0 });
    store.forDecision(streamEvent(), ['griffin0502']);
    expect(store.snapshot()).toMatchObject({ rulesSupplied: 1, decisionsWithPolicy: 1 });
  });
});
