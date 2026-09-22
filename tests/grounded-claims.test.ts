import { describe, expect, it } from 'vitest';
import { sameBatchClaim, unsupportedAudienceClaim } from '../src/reaction/grounded-claims';
describe('Railway audience assertions', () => {
  const question = 'Ну сколько, 10% зрителей это русские, нет?';
  it('rejects the confident comparative claims recorded in production', () => {
    expect(unsupportedAudienceClaim('больше намного обычно', question)).toBe(true);
    expect(unsupportedAudienceClaim('да не, больше точно', question)).toBe(true);
  });
  it('keeps uncertainty, questions and unrelated comparisons', () => {
    expect(unsupportedAudienceClaim('думаю больше', question)).toBe(false);
    expect(unsupportedAudienceClaim('а сколько точно?', question)).toBe(false);
    expect(unsupportedAudienceClaim('этот дом намного больше', 'Как вам дом?')).toBe(false);
  });
  it('deduplicates reordering without merging opposite opinions', () => {
    expect(sameBatchClaim('этот дом больше', 'ну этот дом же больше')).toBe(true);
    expect(sameBatchClaim('этот дом больше', 'этот дом не больше')).toBe(false);
  });
});
