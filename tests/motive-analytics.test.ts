import { describe, expect, it } from 'vitest';
import { computeMotiveAnalytics, LEGACY_LINK_WINDOW_MS, resolveVerdictLink } from '../src/learning/motive-analytics';
import { MessageVerdictRecord } from '../src/personas/types';
import { SentMessageMotiveRecord } from '../src/reaction/types';

const T0 = 1_700_000_000_000;

function motive(overrides: Partial<SentMessageMotiveRecord> & { id: string }): SentMessageMotiveRecord {
  return {
    createdAt: T0, username: 'bot-one', message: 'сообщение', eventId: 'e1', triggerKind: 'stream_event',
    motive: 'react', sourceType: 'none', sourceValidated: true, validatedSourceType: 'none', learnedRuleIds: [],
    ...overrides,
  };
}

function verdict(overrides: Partial<MessageVerdictRecord> & { id: string }): MessageVerdictRecord {
  return { createdAt: T0 + 60_000, username: 'bot-one', message: 'сообщение', verdict: 'good', ...overrides };
}

const personal = (id: string, extra: Partial<SentMessageMotiveRecord> = {}) =>
  motive({ id, sourceType: 'relationship', sourceValidated: true, validatedSourceType: 'relationship', ...extra });
const generic = (id: string, extra: Partial<SentMessageMotiveRecord> = {}) =>
  motive({ id, sourceType: 'event_emotion', sourceValidated: true, validatedSourceType: 'event_emotion', ...extra });

describe('CRITICAL — same account, same text, two sendings, two verdicts', () => {
  it('keeps the dislike on A (event_emotion) and the like on B (relationship) with no mixing', () => {
    const analytics = computeMotiveAnalytics(
      [
        generic('A', { message: 'ахахах', createdAt: T0, eventId: 'event-a' }),
        personal('B', { message: 'ахахах', createdAt: T0 + 10 * 60_000, eventId: 'event-b' }),
      ],
      [
        verdict({ id: 'v-b', message: 'ахахах', verdict: 'good', reactionId: 'B', linkKind: 'exact', createdAt: T0 + 11 * 60_000 }),
        verdict({ id: 'v-a', message: 'ахахах', verdict: 'bad', reactionId: 'A', linkKind: 'exact', createdAt: T0 + 12 * 60_000 }),
      ],
    );
    const byType = Object.fromEntries(analytics.bySourceType.map((row) => [row.sourceType, row]));
    expect(byType['event_emotion']).toMatchObject({ judged: 1, approved: 0 });
    expect(byType['relationship']).toMatchObject({ judged: 1, approved: 1 });
    expect(analytics.personalSourceApprovalRate).toBe(1);
    expect(analytics.genericEventOnlyApprovalRate).toBe(0);
    expect(analytics.linkQuality.exactIdMatches).toBe(2);
  });
});

describe('same text in different logical stream sessions', () => {
  it('a verdict from session 2 never lands on the session-1 sending', () => {
    const session1 = generic('S1', { message: 'норм', createdAt: T0 });
    const session2 = personal('S2', { message: 'норм', createdAt: T0 + 2 * 24 * 60 * 60_000 });
    const analytics = computeMotiveAnalytics(
      [session1, session2],
      [verdict({ id: 'v', message: 'норм', verdict: 'good', reactionId: 'S2', linkKind: 'exact', createdAt: session2.createdAt + 60_000 })],
    );
    const byType = Object.fromEntries(analytics.bySourceType.map((row) => [row.sourceType, row]));
    expect(byType['event_emotion']?.judged).toBe(0);
    expect(byType['relationship']?.judged).toBe(1);
  });

  it('even a legacy verdict stays inside its own evening: the window rules out the other session', () => {
    const session1 = generic('S1', { message: 'норм', createdAt: T0 });
    const session2 = personal('S2', { message: 'норм', createdAt: T0 + 2 * 24 * 60 * 60_000 });
    const legacy = verdict({ id: 'v', message: 'норм', createdAt: session2.createdAt + 60_000 });
    expect(resolveVerdictLink(legacy, [session1, session2])).toEqual({ kind: 'legacy', motive: session2 });
  });
});

describe('exact-id join', () => {
  it('joins by reaction id regardless of how the text was typed', () => {
    const analytics = computeMotiveAnalytics(
      [personal('R1', { message: 'привет  мир' })],
      [verdict({ id: 'v', message: 'совсем другой текст', username: 'BOT-ONE', reactionId: 'R1', linkKind: 'exact' })],
    );
    expect(analytics.linkQuality.exactIdMatches).toBe(1);
    expect(analytics.personalSourceApprovalRate).toBe(1);
  });

  it('a verdict with an id that has no motive row is unmatched, not text-repaired', () => {
    const analytics = computeMotiveAnalytics(
      [personal('R1', { message: 'ахахах' })],
      [verdict({ id: 'v', message: 'ахахах', reactionId: 'R-gone', linkKind: 'exact' })],
    );
    expect(analytics.linkQuality.unmatchedVerdicts).toBe(1);
    expect(analytics.totalJudged).toBe(0);
  });
});

describe('legacy fallback — verdicts written before ids existed', () => {
  it('recovers a unique sending in the window, and reports it apart from exact links', () => {
    const analytics = computeMotiveAnalytics(
      [personal('R1', { message: 'ну и момент', createdAt: T0 })],
      [verdict({ id: 'v', message: 'ну и момент', createdAt: T0 + 30 * 60_000 })],
    );
    expect(analytics.linkQuality.legacyFallbackMatches).toBe(1);
    // Strict headline excludes it; includingLegacy counts it.
    expect(analytics.totalJudged).toBe(0);
    expect(analytics.personalSourceApprovalRate).toBeNull();
    expect(analytics.includingLegacy.totalJudged).toBe(1);
    expect(analytics.includingLegacy.personalSourceApprovalRate).toBe(1);
  });

  it('two identical sendings almost at once: legacy_ambiguous, linked to neither', () => {
    const analytics = computeMotiveAnalytics(
      [
        generic('A', { message: 'ахахах', createdAt: T0 }),
        personal('B', { message: 'ахахах', createdAt: T0 + 5_000 }),
      ],
      [verdict({ id: 'v', message: 'ахахах', verdict: 'good', createdAt: T0 + 60_000 })],
    );
    expect(analytics.linkQuality.legacyAmbiguous).toBe(1);
    expect(analytics.includingLegacy.totalJudged).toBe(0);
    expect(analytics.totalJudged).toBe(0);
    for (const row of analytics.bySourceType) expect(row.judged).toBe(0);
  });

  it('a sending outside the window or after the verdict is not a candidate', () => {
    const tooOld = personal('OLD', { message: 'норм', createdAt: T0 - LEGACY_LINK_WINDOW_MS - 1 });
    const later = personal('LATER', { message: 'норм', createdAt: T0 + 10 * 60_000 });
    expect(resolveVerdictLink(verdict({ id: 'v', message: 'норм', createdAt: T0 }), [tooOld, later]).kind).toBe('unmatched');
  });

  it('a verdict with no sending at all is unmatched', () => {
    const analytics = computeMotiveAnalytics([], [verdict({ id: 'v', message: 'старое сообщение' })]);
    expect(analytics.linkQuality.unmatchedVerdicts).toBe(1);
    expect(analytics.personalSourceApprovalRate).toBeNull();
  });
});

describe('new data never falls back to text', () => {
  it('a lost-id verdict is counted as lost even when a unique text match exists', () => {
    const analytics = computeMotiveAnalytics(
      [personal('R1', { message: 'ахахах', createdAt: T0 })],
      [verdict({ id: 'v', message: 'ахахах', createdAt: T0 + 60_000, linkKind: 'lost' })],
    );
    expect(analytics.linkQuality.lostIdVerdicts).toBe(1);
    expect(analytics.linkQuality.legacyFallbackMatches).toBe(0);
    expect(analytics.includingLegacy.totalJudged).toBe(0);
  });
});

describe('strict accuracy', () => {
  it('counts a message under its validated category, and an unvalidated claim never reaches the personal bucket', () => {
    const analytics = computeMotiveAnalytics(
      [
        motive({ id: 'C', message: 'переезд', sourceType: 'knowledge_gap', sourceValidated: true, validatedSourceType: 'current_life' }),
        motive({ id: 'F', message: 'выдуманное', sourceType: 'memory', sourceValidated: false }),
      ],
      [
        verdict({ id: 'v1', reactionId: 'C', linkKind: 'exact', verdict: 'good' }),
        verdict({ id: 'v2', reactionId: 'F', linkKind: 'exact', verdict: 'good' }),
      ],
    );
    expect(analytics.bySourceType.map((row) => row.sourceType).sort()).toEqual(['current_life', 'memory']);
    expect(analytics.personalSourceApprovalRate).toBe(1);
    expect(analytics.genericEventOnlyApprovalRate).toBe(1);
    expect(analytics.totalJudged).toBe(2);
  });
});
