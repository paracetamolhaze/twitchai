import { describe, expect, it } from 'vitest';
import { canonicalTopicIds, expandTopicText, topicRelevance, topicTokens } from '../src/shared/topics';

/**
 * Fixture C — the central "Dota 2" / «доту» bug. Canon writes topics in Latin, the stream speaks
 * Russian case endings, and every token matcher in the pipeline used to treat them as unrelated.
 * The registry is the one place the bridge lives; these tests pin that the bridge holds in both
 * directions and that it never widens into a stemmer.
 */
describe('canonical topic registry', () => {
  it('maps Dota 2 and its Russian case forms to one id', () => {
    expect(canonicalTopicIds('Dota 2 на весь вечер')).toContain('dota2');
    expect(canonicalTopicIds('сегодня играем в доту')).toContain('dota2');
    expect(canonicalTopicIds('вчера в дотке порвали')).toContain('dota2');
  });

  it('matches aliases by exact token equality only — never by prefix', () => {
    // "дотянул" starts with "дот" but is not Dota; a stemmer would buy the match and this bug.
    expect(canonicalTopicIds('еле дотянул до конца недели')).toEqual(new Set());
    expect(canonicalTopicIds('дотошный человек')).toEqual(new Set());
  });

  it('gives "Dota 2" and «доту» a nonzero mutual relevance', () => {
    expect(topicRelevance('сегодня катаем доту', 'Dota 2')).toBeGreaterThan(0);
    expect(topicRelevance('Dota 2', 'опять сидит в доте весь вечер')).toBeGreaterThan(0);
  });

  it('bridges China and Shanghai across scripts the same way', () => {
    expect(topicRelevance('переезд в Китай', 'жизнь в china, аренда')).toBeGreaterThan(0);
    expect(topicRelevance('шанхае дорого жить', 'Shanghai')).toBeGreaterThan(0);
  });

  it('unregistered vocabulary still meets through transliteration', () => {
    // Not in the registry — the general translit path carries it, exactly as before.
    expect(topicRelevance('стефан опять объясняет', 'stefan и его лекции')).toBeGreaterThan(0);
  });

  it('unrelated texts stay unrelated after expansion', () => {
    expect(topicRelevance('сегодня катаем доту', 'рецепт борща на зиму')).toBe(0);
  });

  it('expandTopicText appends ids and translit without destroying the original text', () => {
    const expanded = expandTopicText('играем в доту');
    expect(expanded).toContain('играем в доту');
    expect(expanded).toContain('dota2');
    expect(topicTokens('доту').has('dota2')).toBe(true);
  });
});
