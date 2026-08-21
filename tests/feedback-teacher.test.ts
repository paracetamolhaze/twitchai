import { describe, expect, it, vi } from 'vitest';
import { BrainInteractionRequest, BrainInteractionResponse } from '../src/brain/gemini-brain.service';
import { FeedbackTeacher, MIN_NEW_VERDICTS_FOR_AUTO_RUN } from '../src/learning/feedback-teacher';
import { LearnedPolicyStore } from '../src/learning/learned-policy-store';
import { LearnedPolicyRule, TeacherAction } from '../src/learning/learned-policy.types';
import { Logger } from '../src/logger';
import { MessageVerdictRecord } from '../src/personas/types';
import { MemoryRepository } from '../src/persistence/memory-repository';
import { StreamEvent } from '../src/stream-brain/types';
import { UsageTracker } from '../src/usage/usage-tracker';

const logger = new Logger('TEST', 'error');

function action(overrides: Partial<TeacherAction>): TeacherAction {
  return {
    action: 'NO_CHANGE', ruleId: '', scopeType: 'global', scopeKey: '',
    rule: '', rationale: '', confidence: 0, evidenceIds: [], ...overrides,
  };
}

function verdict(overrides: Partial<MessageVerdictRecord> & { id: string }): MessageVerdictRecord {
  return {
    createdAt: 1_700_000_000_000, username: 'griffin0502', message: 'сообщение',
    verdict: 'bad', ...overrides,
  };
}

function streamEvent(id: string, overrides: Partial<StreamEvent> = {}): StreamEvent {
  return {
    id, timestamp: 1_700_000_000_000, type: 'speech', summary: 'стример что-то сказал',
    importance: 0.5, confidence: 0.9, source: 'transcription', directMentions: [], ...overrides,
  };
}

interface HarnessOptions {
  actions?: TeacherAction[];
  fail?: boolean;
  personas?: Record<string, { interests: string[]; expertise: string[]; weakTopics: string[] }>;
  /** One entry per attempt, in order, so a retry can be given a different answer than the first try. */
  responses?: Array<Partial<BrainInteractionResponse> & { throws?: boolean }>;
}

async function harness(verdicts: MessageVerdictRecord[], options: HarnessOptions = {}) {
  const repository = new MemoryRepository();
  await repository.initialize();
  for (const item of verdicts) await repository.saveMessageVerdict(item);

  const usage = { inputTokens: 4_000, cachedInputTokens: 0, outputTokens: 300, thoughtTokens: 500, totalTokens: 4_800 };
  const requests: BrainInteractionRequest[] = [];
  const client = {
    create: vi.fn(async (request: BrainInteractionRequest): Promise<BrainInteractionResponse> => {
      requests.push(structuredClone(request));
      if (options.fail) throw new Error('provider exploded');
      const scripted = options.responses?.[requests.length - 1];
      if (scripted?.throws) throw new Error('provider exploded');
      if (scripted) {
        return {
          id: `teacher-${requests.length}`, status: 'completed', usage,
          ...scripted,
        } as BrainInteractionResponse;
      }
      return {
        id: `teacher-${requests.length}`,
        status: 'completed',
        outputText: JSON.stringify({ actions: options.actions ?? [] }),
        usage,
      };
    }),
  };
  const policyStore = new LearnedPolicyStore(repository, logger);
  await policyStore.load();
  const usageTracker = new UsageTracker();
  const teacher = new FeedbackTeacher({
    client,
    model: 'test/teacher-model',
    repository,
    policyStore,
    // Supplying `personas` means "these are the only accounts that exist", so an unknown name
    // resolves to undefined exactly as it would against a real bot roster. Omitting it means the
    // test does not care and every name resolves.
    personaProfile: (username) => (options.personas
      ? options.personas[username]
      : { interests: [], expertise: [], weakTopics: [] }),
    recentChat: () => [],
    usage: usageTracker,
    logger,
  });
  return { teacher, policyStore, repository, requests, client, usageTracker };
}

describe('FeedbackTeacher batch learning', () => {
  it('A. turns a cluster of generic-evaluator dislikes into one global rule, not two literal ones', async () => {
    const verdicts = [
      verdict({ id: 'case-1', message: 'Яндекс это мощно конечно', note: 'просто оценивает уже сказанный факт' }),
      verdict({ id: 'case-2', message: 'Топ-200 Китая это солидно', note: 'просто оценивает уже сказанный факт' }),
    ];
    const { teacher, policyStore } = await harness(verdicts, {
      actions: [action({
        action: 'CREATE_RULE', scopeType: 'global',
        rule: 'Do not turn a fact the stream just stated into a generic evaluative verdict.',
        rationale: 'Two rated messages restated a fact and added only a grade.',
        confidence: 0.8, evidenceIds: ['case-1', 'case-2'],
      })],
    });
    const outcome = await teacher.runManually();
    expect(outcome?.created).toBe(1);
    const rules = policyStore.active();
    expect(rules).toHaveLength(1);
    expect(rules[0]?.scopeType).toBe('global');
    expect(rules[0]?.supportCount).toBe(2);
    // The rule generalizes rather than quoting: neither disliked string appears in it.
    expect(rules[0]?.rule).not.toContain('мощно');
    expect(rules[0]?.rule).not.toContain('Топ-200');
  });

  it('D. accepts a persona-scoped rule when the note contradicts that account\'s own weak topics', async () => {
    const { teacher, policyStore } = await harness(
      [verdict({ id: 'case-1', username: 'supercser2', message: 'Бери СК и не мудри', note: 'он не знает доту, почему советует' })],
      {
        personas: { supercser2: { interests: [], expertise: [], weakTopics: ['dota'] } },
        actions: [action({
          action: 'CREATE_RULE', scopeType: 'persona', scopeKey: 'supercser2',
          rule: 'supercser2 must not give confident Dota advice; Dota is one of its weak topics.',
          rationale: 'Operator flagged coaching on a listed weak topic.',
          confidence: 0.75, evidenceIds: ['case-1'],
        })],
      },
    );
    await teacher.runManually();
    const rules = policyStore.active();
    expect(rules[0]?.scopeType).toBe('persona');
    expect(rules[0]?.scopeKey).toBe('supercser2');
  });

  it('rejects a persona rule naming an account that does not exist', async () => {
    // Only griffin0502 exists; a rule scoped to anyone else could never be retrieved for a real
    // candidate, so it is dropped rather than stored as an unreachable row.
    const { teacher, policyStore } = await harness(
      [verdict({ id: 'case-1' })],
      {
        personas: { griffin0502: { interests: [], expertise: [], weakTopics: [] } },
        actions: [action({
          action: 'CREATE_RULE', scopeType: 'persona', scopeKey: 'nobody_here',
          rule: 'nobody_here should stop doing that.', rationale: 'x', confidence: 0.9, evidenceIds: ['case-1'],
        })],
      },
    );
    const outcome = await teacher.runManually();
    expect(outcome?.rejected).toBe(1);
    expect(outcome?.created).toBe(0);
    expect(policyStore.active()).toHaveLength(0);
  });

  it('F. updates an existing rule instead of creating a duplicate for the same concept', async () => {
    const { teacher, policyStore, repository } = await harness([verdict({ id: 'case-1' })], {
      actions: [action({
        action: 'UPDATE_RULE', ruleId: 'rule-existing', confidence: 0.92,
        rationale: 'A third case shows the same thing.', evidenceIds: ['case-1'],
      })],
    });
    const existing: LearnedPolicyRule = {
      id: 'rule-existing', scopeType: 'global', scopeKey: '',
      rule: 'Do not restate an opinion just to endorse it.', rationale: 'earlier evidence',
      confidence: 0.7, supportCount: 2, positiveEvidence: 0, negativeEvidence: 2, status: 'active',
      teacherModel: 'test/teacher-model', evidenceIds: ['old-1', 'old-2'],
      createdAt: 1_000, updatedAt: 1_000, version: 1,
    };
    await repository.applyLearnedPolicyBatch({ upserts: [existing], processedVerdictIds: [], processedAt: 1_000 });
    await policyStore.load();

    const outcome = await teacher.runManually();
    expect(outcome?.updated).toBe(1);
    expect(outcome?.created).toBe(0);
    const rules = policyStore.active();
    expect(rules).toHaveLength(1);
    expect(rules[0]?.confidence).toBe(0.92);
    // Support is the merged distinct evidence set, so a re-cited case cannot inflate it twice.
    expect(rules[0]?.supportCount).toBe(3);
    expect(rules[0]?.version).toBe(2);
  });

  it('G. can supersede a rule that new evidence contradicts', async () => {
    const { teacher, policyStore, repository } = await harness(
      [verdict({ id: 'case-1', message: 'баранина', verdict: 'good' })],
      { actions: [action({ action: 'DISABLE_RULE', ruleId: 'rule-broad', rationale: 'Likes contradict it.' })] },
    );
    await repository.applyLearnedPolicyBatch({
      upserts: [{
        id: 'rule-broad', scopeType: 'global', scopeKey: '', rule: 'Never send one-word messages.',
        rationale: 'too broad', confidence: 0.6, supportCount: 2, positiveEvidence: 0, negativeEvidence: 2,
        status: 'active', teacherModel: 'test/teacher-model', evidenceIds: [], createdAt: 1_000,
        updatedAt: 1_000, version: 1,
      }],
      processedVerdictIds: [], processedAt: 1_000,
    });
    await policyStore.load();

    const outcome = await teacher.runManually();
    expect(outcome?.disabled).toBe(1);
    expect(policyStore.active()).toHaveLength(0);
    expect(policyStore.byId('rule-broad')?.status).toBe('superseded');
  });

  it('H. an isolated dislike with a vague note produces no rule when the Teacher says NO_CHANGE', async () => {
    const { teacher, policyStore } = await harness(
      [verdict({ id: 'case-1', note: 'не нравится' })],
      { actions: [action({ action: 'NO_CHANGE' })] },
    );
    const outcome = await teacher.runManually();
    expect(outcome?.unchanged).toBe(1);
    expect(outcome?.created).toBe(0);
    expect(policyStore.active()).toHaveLength(0);
  });

  it('K. a provider failure mutates nothing and leaves the batch pending', async () => {
    const { teacher, policyStore, repository } = await harness([
      verdict({ id: 'case-1' }), verdict({ id: 'case-2' }),
    ], { fail: true });
    const outcome = await teacher.runManually();
    expect(outcome).toBeUndefined();
    expect(policyStore.all()).toHaveLength(0);
    // Still unprocessed, so the next run repeats exactly this batch.
    expect(await repository.listUnprocessedMessageVerdicts(50)).toHaveLength(2);
  });

  it('L. rejects the whole action when it cites a feedback id that was never in the batch', async () => {
    const { teacher, policyStore } = await harness([verdict({ id: 'case-1' })], {
      actions: [action({
        action: 'CREATE_RULE', scopeType: 'global', rule: 'Some rule.', rationale: 'x',
        confidence: 0.9, evidenceIds: ['case-1', 'case-invented'],
      })],
    });
    const outcome = await teacher.runManually();
    expect(outcome?.rejected).toBe(1);
    expect(outcome?.created).toBe(0);
    expect(policyStore.active()).toHaveLength(0);
  });

  it('never re-opens a rule the operator disabled in the dashboard', async () => {
    const { teacher, policyStore, repository } = await harness([verdict({ id: 'case-1' })], {
      actions: [action({ action: 'UPDATE_RULE', ruleId: 'rule-off', confidence: 0.95, evidenceIds: ['case-1'] })],
    });
    await repository.applyLearnedPolicyBatch({
      upserts: [{
        id: 'rule-off', scopeType: 'global', scopeKey: '', rule: 'Something the operator switched off.',
        rationale: 'x', confidence: 0.8, supportCount: 1, positiveEvidence: 0, negativeEvidence: 1,
        status: 'disabled', teacherModel: 'test/teacher-model', evidenceIds: [], createdAt: 1_000,
        updatedAt: 1_000, version: 1,
      }],
      processedVerdictIds: [], processedAt: 1_000,
    });
    await policyStore.load();

    const outcome = await teacher.runManually();
    expect(outcome?.rejected).toBe(1);
    expect(policyStore.byId('rule-off')?.status).toBe('disabled');
    expect(policyStore.byId('rule-off')?.confidence).toBe(0.8);
  });

  it('marks a batch processed so a second run does not count the same evidence twice', async () => {
    const { teacher, repository } = await harness([verdict({ id: 'case-1' }), verdict({ id: 'case-2' })], {
      actions: [action({ action: 'NO_CHANGE' })],
    });
    await teacher.runManually();
    expect(await repository.listUnprocessedMessageVerdicts(50)).toHaveLength(0);
    expect(await teacher.runManually()).toBeUndefined();
  });

  it('does not run automatically below the new-verdict threshold', async () => {
    const few = Array.from({ length: MIN_NEW_VERDICTS_FOR_AUTO_RUN - 1 }, (_, index) => verdict({ id: `case-${index}` }));
    const { teacher, client } = await harness(few, { actions: [] });
    expect(await teacher.maybeRunAutomatically()).toBeUndefined();
    expect(client.create).not.toHaveBeenCalled();
  });

  it('runs automatically once enough new verdicts exist, then holds off for the cooldown', async () => {
    const enough = Array.from({ length: MIN_NEW_VERDICTS_FOR_AUTO_RUN }, (_, index) => verdict({ id: `case-${index}` }));
    const { teacher, client, repository } = await harness(enough, { actions: [action({ action: 'NO_CHANGE' })] });
    expect(await teacher.maybeRunAutomatically()).toBeDefined();
    expect(client.create).toHaveBeenCalledTimes(1);

    for (let index = 0; index < MIN_NEW_VERDICTS_FOR_AUTO_RUN; index += 1) {
      await repository.saveMessageVerdict(verdict({ id: `later-${index}` }));
    }
    expect(await teacher.maybeRunAutomatically()).toBeUndefined();
    expect(client.create).toHaveBeenCalledTimes(1);
  });

  it('hands the Teacher a self-contained case: the moment, the note, and the account\'s weak topics', async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await repository.saveStreamEvent(streamEvent('event-42', {
      summary: 'O: это камбэк сейчас будет',
      speech: 'O: это камбэк сейчас будет',
      visualContext: 'персонаж стоит в лесу',
      audience: 'people_with_streamer',
      type: 'question',
    }));
    await repository.saveMessageVerdict(verdict({
      id: 'case-1', username: 'alexmadkid', message: 'камбэк пошел получается',
      note: 'повторяет то что уже сказали', eventId: 'event-42',
    }));

    const requests: BrainInteractionRequest[] = [];
    const policyStore = new LearnedPolicyStore(repository, logger);
    await policyStore.load();
    const teacher = new FeedbackTeacher({
      client: {
        create: async (request) => {
          requests.push(structuredClone(request));
          return {
            id: 'x', status: 'completed', outputText: JSON.stringify({ actions: [] }),
            usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, thoughtTokens: 0, totalTokens: 2 },
          };
        },
      },
      model: 'test/teacher-model',
      repository,
      policyStore,
      personaProfile: () => ({ interests: ['dota'], expertise: [], weakTopics: ['экономика'] }),
      recentChat: () => [{ username: 'viewer', message: 'ну наконец-то', kind: 'viewer', timestamp: 1 }],
      usage: new UsageTracker(),
      logger,
    });
    await teacher.runManually();

    const payload = JSON.parse(requests[0]!.input) as {
      feedbackCases: Array<Record<string, unknown> & { event?: Record<string, unknown> }>;
    };
    const sent = payload.feedbackCases[0]!;
    expect(sent.note).toBe('повторяет то что уже сказали');
    expect(sent.triggerKind).toBe('external_stream_event');
    expect(sent.event?.speech).toBe('O: это камбэк сейчас будет');
    expect(sent.event?.audience).toBe('people_with_streamer');
    expect(sent.event?.grounding).toBe('speech+scene');
    expect((sent.persona as { weakTopics: string[] }).weakTopics).toEqual(['экономика']);
    expect(sent.recentChat).toHaveLength(1);
  });

  it('A. a truncated response mutates nothing, leaves the batch pending, and names the reason', async () => {
    // The exact production failure: finish_reason 'length', which the client reports as 'incomplete'.
    // Both attempts truncated, so the run gives up rather than looping.
    const { teacher, policyStore, repository, client } = await harness(
      [verdict({ id: 'case-1' }), verdict({ id: 'case-2' })],
      { responses: [{ status: 'incomplete', finishReason: 'length', outputText: '{"actions":[{"acti' },
        { status: 'incomplete', finishReason: 'length', outputText: '{"actions":[{"acti' }] },
    );
    expect(await teacher.runManually()).toBeUndefined();
    expect(policyStore.all()).toHaveLength(0);
    expect(await repository.listUnprocessedMessageVerdicts(50)).toHaveLength(2);
    expect(client.create).toHaveBeenCalledTimes(2);
    const status = await teacher.status();
    expect(status.lastRun).toMatchObject({ result: 'failed', category: 'incomplete_response' });
    expect(status.pendingFeedback).toBe(2);
  });

  it('C. retries once when the first answer is unusable, and accepts the second', async () => {
    const { teacher, policyStore, requests } = await harness([verdict({ id: 'case-1' })], {
      responses: [
        { status: 'incomplete', finishReason: 'length', outputText: '{"actions":[' },
        {
          status: 'completed',
          outputText: JSON.stringify({
            actions: [action({
              action: 'CREATE_RULE', scopeType: 'global', rule: 'A rule the retry produced.',
              rationale: 'x', confidence: 0.8, evidenceIds: ['case-1'],
            })],
          }),
        },
      ],
    });
    const outcome = await teacher.runManually();
    expect(outcome?.created).toBe(1);
    expect(requests).toHaveLength(2);
    // The repair is principled, not a blind repeat: the second attempt asks the model to spend less
    // of the same budget thinking, because spending it all thinking is what failed.
    expect(requests[0]?.thinkingLevel).toBe('high');
    expect(requests[1]?.thinkingLevel).toBe('low');
    // Same batch, so a rule from the retry rests on exactly what the first attempt was shown.
    expect(requests[0]?.input).toBe(requests[1]?.input);
    expect(policyStore.active()).toHaveLength(1);
  });

  it('C. never retries more than once', async () => {
    const { teacher, client } = await harness([verdict({ id: 'case-1' })], {
      responses: Array.from({ length: 5 }, () => ({ status: 'incomplete' as const, finishReason: 'length' })),
    });
    await teacher.runManually();
    expect(client.create).toHaveBeenCalledTimes(2);
  });

  it('D. a second failing run leaves the batch pending and keeps reporting failure', async () => {
    const { teacher, repository } = await harness([verdict({ id: 'case-1' }), verdict({ id: 'case-2' })], {
      responses: Array.from({ length: 8 }, () => ({ status: 'incomplete' as const, finishReason: 'length' })),
    });
    await teacher.runManually();
    await teacher.runManually();
    expect(await repository.listUnprocessedMessageVerdicts(50)).toHaveLength(2);
    expect((await teacher.status()).lastRun).toMatchObject({ result: 'failed' });
  });

  it('K. a verdict that survives a failed run carries no processed stamp', async () => {
    const { teacher, repository } = await harness([verdict({ id: 'case-1' })], {
      responses: [{ status: 'incomplete' as const }, { status: 'incomplete' as const }],
    });
    await teacher.runManually();
    const stored = await repository.listMessageVerdicts(10);
    expect(stored[0]?.processedAt).toBeUndefined();
  });

  it('records what a failed attempt cost, because a truncated answer was still billed', async () => {
    const { teacher, usageTracker } = await harness([verdict({ id: 'case-1' })], {
      responses: [{ status: 'incomplete' as const }, { status: 'incomplete' as const }],
    });
    await teacher.runManually();
    // Two attempts, both billed, neither previously counted anywhere.
    expect(usageTracker.snapshot().teacherBrain.interactions).toBe(2);
  });

  it('reports invalid JSON as its own category, with bounded structural diagnostics only', async () => {
    const { teacher } = await harness([verdict({ id: 'case-1' })], {
      responses: [{ outputText: '{"actions": [ this is not json' }, { outputText: '{"actions": [ still not' }],
    });
    await teacher.runManually();
    expect((await teacher.status()).lastRun).toMatchObject({ category: 'invalid_json' });
  });

  it('reports a schema mismatch separately from invalid JSON', async () => {
    const { teacher } = await harness([verdict({ id: 'case-1' })], {
      responses: [{ outputText: '{"rules": []}' }, { outputText: '{"rules": []}' }],
    });
    await teacher.runManually();
    expect((await teacher.status()).lastRun).toMatchObject({ category: 'schema_mismatch' });
  });

  it('B/E. drains a real backlog across runs, committing each batch it completes', async () => {
    // 25 pending, capped at 12 per run: the first run takes a batch, marks exactly that batch read,
    // and the next run picks up what is left. Nothing is lost and nothing is counted twice.
    const many = Array.from({ length: 25 }, (_, index) => verdict({
      id: `case-${index}`,
      verdict: index % 3 === 0 ? 'good' : 'bad',
      message: `сообщение номер ${index}`,
      ...(index % 3 === 0 ? {} : { note: 'повторяет уже сказанное' }),
    }));
    const { teacher, policyStore, repository } = await harness(many, {
      actions: [action({
        action: 'CREATE_RULE', scopeType: 'global',
        rule: 'A reaction must contribute a stance, feeling, correction or question of its own.',
        rationale: 'Several rated messages only replayed what was already said.',
        confidence: 0.8, evidenceIds: ['case-1'],
      })],
    });

    const first = await teacher.runManually();
    expect(first?.created).toBe(1);
    expect(first?.casesConsidered).toBeLessThanOrEqual(12);
    const remaining = await repository.listUnprocessedMessageVerdicts(50);
    expect(remaining).toHaveLength(25 - (first?.casesConsidered ?? 0));

    await teacher.runManually();
    expect((await repository.listUnprocessedMessageVerdicts(50)).length)
      .toBeLessThan(remaining.length);
    expect(policyStore.active().length).toBeGreaterThan(0);
    expect((await teacher.status()).lastRun).toMatchObject({ result: 'success' });
  });

  it('the acceptance criterion: three dislikes become one principle that reaches a moment sharing none of their words', async () => {
    // The three real disliked messages, none of which share vocabulary with the later event.
    const verdicts = [
      verdict({ id: 'case-1', message: 'Яндекс это мощно конечно', note: 'оценивает уже сказанный факт' }),
      verdict({ id: 'case-2', message: 'Топ-200 Китая это солидно', note: 'то же самое, просто подтверждает' }),
      verdict({ id: 'case-3', message: 'легенда без вопросов', note: 'повторяет чужое мнение и соглашается' }),
    ];
    const { teacher, policyStore } = await harness(verdicts, {
      actions: [action({
        action: 'CREATE_RULE', scopeType: 'global',
        rule: 'Do not restate something the stream already said or judged merely to confirm or intensify it.',
        rationale: 'Three rated messages added only agreement to a point already made.',
        confidence: 0.86, evidenceIds: ['case-1', 'case-2', 'case-3'],
      })],
    });
    await teacher.runManually();

    // A moment with no lexical overlap with any of the three: different game, different words.
    const unseenMoment = streamEvent('event-new', {
      summary: 'S: этот патч реально сломал керри, играть невозможно',
      speech: 'S: этот патч реально сломал керри, играть невозможно',
      type: 'conversation',
    });
    const policy = policyStore.forDecision(unseenMoment, ['griffin0502']);
    expect(policy?.global).toEqual([
      'Do not restate something the stream already said or judged merely to confirm or intensify it.',
    ]);
    // And it transferred as a principle, not as any of the strings that produced it.
    const attached = policy!.global.join(' ');
    for (const disliked of ['Яндекс', 'Топ-200', 'легенда', 'мощно', 'солидно']) {
      expect(attached).not.toContain(disliked);
    }
  });

  it('marks an autonomous message as persona_drive and looks up no event for it', async () => {
    const { teacher, requests } = await harness(
      [verdict({ id: 'case-1', eventId: 'persona-drive:abc' })],
      { actions: [] },
    );
    await teacher.runManually();
    const payload = JSON.parse(requests[0]!.input) as { feedbackCases: Array<Record<string, unknown>> };
    expect(payload.feedbackCases[0]?.triggerKind).toBe('persona_drive');
    expect(payload.feedbackCases[0]?.event).toBeUndefined();
  });
});

describe('fixture I — a case carries what the model was already told', () => {
  it('attaches the motive record and the rules supplied at generation to the case the Teacher reads', async () => {
    const { teacher, repository, policyStore, requests } = await harness([
      verdict({ id: 'v1', message: 'ахаха ну и заруба пошла', note: 'опять смех в начале' }),
    ]);
    // The rule was in the payload when the message was generated — and the message broke it anyway.
    await repository.applyLearnedPolicyBatch({
      upserts: [{
        id: 'rule-laughter', scopeType: 'global', scopeKey: '',
        rule: 'Do not open commentary with formulaic laughter.', rationale: 'operator feedback',
        confidence: 0.9, supportCount: 3, positiveEvidence: 0, negativeEvidence: 3, status: 'active',
        teacherModel: 'test', evidenceIds: [], createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000, version: 1,
      }],
      processedVerdictIds: [], processedAt: 1_700_000_000_000,
    });
    await policyStore.load();
    await repository.saveSentMessageMotive({
      id: 'm1', createdAt: 1_699_999_999_000, username: 'griffin0502',
      message: 'ахаха ну и заруба пошла', eventId: 'event-1', triggerKind: 'stream_event',
      motive: 'react', sourceType: 'event_emotion', sourceValidated: true,
      validatedSourceType: 'event_emotion', learnedRuleIds: ['rule-laughter'],
    });
    await teacher.runManually();
    const input = JSON.parse(requests[0]!.input) as { feedbackCases: Array<Record<string, unknown>> };
    const sent = input.feedbackCases[0]!;
    expect(sent.motive).toMatchObject({ motive: 'react', sourceType: 'event_emotion', sourceValidated: true });
    expect(sent.rulesSuppliedAtGeneration).toEqual([
      { id: 'rule-laughter', rule: 'Do not open commentary with formulaic laughter.' },
    ]);
    // And the instruction tells the Teacher what those fields mean.
    expect(requests[0]!.systemInstruction).toContain('rulesSuppliedAtGeneration');
  });

  it('a case with no matching motive record travels without the fields, as every case did before', async () => {
    const { teacher, requests } = await harness([verdict({ id: 'v1', message: 'обычное сообщение' })]);
    await teacher.runManually();
    const input = JSON.parse(requests[0]!.input) as { feedbackCases: Array<Record<string, unknown>> };
    expect(input.feedbackCases[0]).not.toHaveProperty('motive');
    expect(input.feedbackCases[0]).not.toHaveProperty('rulesSuppliedAtGeneration');
  });
});
