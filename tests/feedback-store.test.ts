import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { Logger } from '../src/logger';
import { PersonaFeedbackStore } from '../src/personas/feedback-store';
import { MessageVerdictRecord } from '../src/personas/types';

function fakeRepository(seed: MessageVerdictRecord[] = []) {
  const rows = [...seed];
  return {
    saved: rows,
    saveMessageVerdict: async (verdict: MessageVerdictRecord): Promise<void> => { rows.unshift(verdict); },
    listMessageVerdicts: async (limit: number): Promise<MessageVerdictRecord[]> => rows.slice(0, limit),
  };
}

function verdict(overrides: Partial<MessageVerdictRecord> = {}): MessageVerdictRecord {
  return {
    id: `v-${Math.random()}`, createdAt: 1_700_000_000_000, username: 'griffin0502',
    message: 'го дальше', verdict: 'good', ...overrides,
  };
}

const logger = new Logger('TEST', 'error');

describe('PersonaFeedbackStore', () => {
  it('A. a liked message becomes an eligible positive example for that persona', async () => {
    const store = new PersonaFeedbackStore(fakeRepository(), logger);
    await store.record({ username: 'griffin0502', message: 'го дальше по классике', verdict: 'good' });
    expect(store.approvedExamplesFor('griffin0502')).toContain('го дальше по классике');
  });

  it('B. a disliked message never appears among approved examples', async () => {
    const store = new PersonaFeedbackStore(fakeRepository(), logger);
    await store.record({ username: 'griffin0502', message: 'плохое сообщение', verdict: 'bad' });
    expect(store.approvedExamplesFor('griffin0502')).not.toContain('плохое сообщение');
    expect(store.approvedExamplesFor('griffin0502')).toHaveLength(0);
  });

  it('C. feedback recorded for one persona never surfaces as another persona\'s example', async () => {
    const store = new PersonaFeedbackStore(fakeRepository(), logger);
    await store.record({ username: 'griffin0502', message: 'уникальная фраза гриффина', verdict: 'good' });
    expect(store.approvedExamplesFor('alexmadkid')).toHaveLength(0);
    expect(store.approvedExamplesFor('griffin0502')).toContain('уникальная фраза гриффина');
  });

  it('E. a near-duplicate of a disliked message is rejected', async () => {
    const store = new PersonaFeedbackStore(fakeRepository(), logger);
    await store.record({ username: 'ya_yebalo', message: 'саппорты в погоню ушли красиво конечно', verdict: 'bad' });
    expect(store.isNearDuplicateOfDisliked('ya_yebalo', 'саппорты в погоню ушли красиво конечно')).toBe(true);
    // A close paraphrase, not the identical string, still trips the same threshold BotHistory uses.
    expect(store.isNearDuplicateOfDisliked('ya_yebalo', 'саппорты в погоню ушли красиво')).toBe(true);
  });

  it('F. a genuinely different message after a dislike is not rejected', async () => {
    const store = new PersonaFeedbackStore(fakeRepository(), logger);
    await store.record({ username: 'ya_yebalo', message: 'саппорты в погоню ушли красиво конечно', verdict: 'bad' });
    expect(store.isNearDuplicateOfDisliked('ya_yebalo', 'кто-нибудь смотрел новый сериал на выходных')).toBe(false);
  });

  it('the near-duplicate check is scoped per persona, not global', async () => {
    const store = new PersonaFeedbackStore(fakeRepository(), logger);
    await store.record({ username: 'ya_yebalo', message: 'саппорты в погоню ушли красиво конечно', verdict: 'bad' });
    expect(store.isNearDuplicateOfDisliked('alexmadkid', 'саппорты в погоню ушли красиво конечно')).toBe(false);
  });

  it('G. never touches canonical persona data — no import of BotPersona or the generator catalog, by construction', async () => {
    const source = await readFile('src/personas/feedback-store.ts', 'utf8');
    expect(source).not.toMatch(/BotPersona|generator-v3|PersonaStore|upsertPersona/);
  });

  it('H. feedback survives a reload from durable storage', async () => {
    const repository = fakeRepository([verdict({ username: 'griffin0502', message: 'старый лайк', verdict: 'good' })]);
    const store = new PersonaFeedbackStore(repository, logger);
    await store.load();
    expect(store.approvedExamplesFor('griffin0502')).toContain('старый лайк');
  });

  it('I. a fresh verdict takes effect immediately — no reload call needed', async () => {
    const store = new PersonaFeedbackStore(fakeRepository(), logger);
    expect(store.approvedExamplesFor('griffin0502')).toHaveLength(0);
    await store.record({ username: 'griffin0502', message: 'только что понравилось', verdict: 'good' });
    // No store.load() between the write and this read.
    expect(store.approvedExamplesFor('griffin0502')).toContain('только что понравилось');
  });

  it('J. a comment on a verdict is preserved through save', async () => {
    const repository = fakeRepository();
    const store = new PersonaFeedbackStore(repository, logger);
    await store.record({
      username: 'griffin0502', message: 'спорное сообщение', verdict: 'bad',
      note: 'повторяет то что уже сказал стример',
    });
    expect(repository.saved[0]?.note).toBe('повторяет то что уже сказал стример');
  });

  it('newest-first ordering survives a batch load from storage', async () => {
    const repository = fakeRepository([
      verdict({ username: 'griffin0502', message: 'новее', createdAt: 2_000, verdict: 'good' }),
      verdict({ username: 'griffin0502', message: 'старее', createdAt: 1_000, verdict: 'good' }),
    ]);
    const store = new PersonaFeedbackStore(repository, logger);
    await store.load();
    expect(store.approvedExamplesFor('griffin0502', 1)).toEqual(['новее']);
  });

  it('caps how many live examples are considered, regardless of how many were liked', async () => {
    const store = new PersonaFeedbackStore(fakeRepository(), logger);
    for (let i = 0; i < 20; i += 1) {
      await store.record({ username: 'griffin0502', message: `лайк номер ${i}`, verdict: 'good' });
    }
    expect(store.approvedExamplesFor('griffin0502').length).toBeLessThan(20);
  });

  it('snapshot reports likes, dislikes, and rejections as they accumulate', async () => {
    const store = new PersonaFeedbackStore(fakeRepository(), logger);
    await store.record({ username: 'a', message: 'x1', verdict: 'good' });
    await store.record({ username: 'b', message: 'x2', verdict: 'bad' });
    store.isNearDuplicateOfDisliked('b', 'x2');
    const snapshot = store.snapshot();
    expect(snapshot.likesAvailable).toBe(1);
    expect(snapshot.dislikesAvailable).toBe(1);
    expect(snapshot.similarityRejected).toBe(1);
    expect(snapshot.approvedLiveExamplesUsed).toBe(0);
  });
});
