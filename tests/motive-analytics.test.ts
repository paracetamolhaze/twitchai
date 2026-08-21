import { describe, expect, it } from 'vitest';
import { computeMotiveAnalytics } from '../src/learning/motive-analytics';
import { MessageVerdictRecord } from '../src/personas/types';
import { SentMessageMotiveRecord } from '../src/reaction/types';

function motive(overrides: Partial<SentMessageMotiveRecord>): SentMessageMotiveRecord {
  return {
    id: Math.random().toString(36).slice(2), createdAt: 1_000, username: 'bot-one',
    message: 'сообщение', eventId: 'e1', triggerKind: 'stream_event',
    motive: 'react', sourceType: 'none', sourceValidated: false, learnedRuleIds: [],
    ...overrides,
  };
}

function verdict(overrides: Partial<MessageVerdictRecord>): MessageVerdictRecord {
  return {
    id: Math.random().toString(36).slice(2), createdAt: 2_000, username: 'bot-one',
    message: 'сообщение', verdict: 'good', ...overrides,
  };
}

describe('verdict x motive analytics — the falsifiability join', () => {
  it('splits approval between validated personal sources and generic event-only messages', () => {
    const analytics = computeMotiveAnalytics([
      motive({ message: 'из любопытства', sourceType: 'curiosity', sourceValidated: true, validatedSourceType: 'curiosity' }),
      motive({ message: 'из жизни', sourceType: 'current_life', sourceValidated: true, validatedSourceType: 'current_life' }),
      motive({ message: 'просто эмоция', sourceType: 'event_emotion', sourceValidated: true, validatedSourceType: 'event_emotion' }),
      motive({ message: 'без повода', sourceType: 'none', sourceValidated: true, validatedSourceType: 'none' }),
    ], [
      verdict({ message: 'из любопытства', verdict: 'good' }),
      verdict({ message: 'из жизни', verdict: 'good' }),
      verdict({ message: 'просто эмоция', verdict: 'bad' }),
      verdict({ message: 'без повода', verdict: 'bad' }),
    ]);
    expect(analytics.personalSourceApprovalRate).toBe(1);
    expect(analytics.genericEventOnlyApprovalRate).toBe(0);
    expect(analytics.totalJudged).toBe(4);
  });

  it('counts a message under its validated category, not under the raw claim', () => {
    const analytics = computeMotiveAnalytics([
      motive({ message: 'переезд', sourceType: 'knowledge_gap', sourceValidated: true, validatedSourceType: 'current_life' }),
    ], []);
    expect(analytics.bySourceType.map((row) => row.sourceType)).toEqual(['current_life']);
  });

  it('an unvalidated claim never reaches the personal bucket, whatever it called itself', () => {
    const analytics = computeMotiveAnalytics([
      motive({ message: 'выдуманное', sourceType: 'memory', sourceValidated: false }),
    ], [verdict({ message: 'выдуманное', verdict: 'good' })]);
    expect(analytics.personalSourceApprovalRate).toBeNull();
    expect(analytics.genericEventOnlyApprovalRate).toBe(1);
  });

  it('joins by account and normalized text, ignoring whitespace differences', () => {
    const analytics = computeMotiveAnalytics([
      motive({ message: 'привет  мир', username: 'bot-two', sourceType: 'curiosity', sourceValidated: true, validatedSourceType: 'curiosity' }),
    ], [verdict({ message: 'привет мир', username: 'BOT-TWO', verdict: 'good' })]);
    expect(analytics.totalJudged).toBe(1);
    expect(analytics.personalSourceApprovalRate).toBe(1);
  });

  it('a verdict on a message with no motive record is left out rather than guessed at', () => {
    const analytics = computeMotiveAnalytics([], [verdict({ message: 'старое сообщение' })]);
    expect(analytics.totalJudged).toBe(0);
    expect(analytics.personalSourceApprovalRate).toBeNull();
  });
});
