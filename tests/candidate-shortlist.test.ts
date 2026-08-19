import { describe, expect, it } from 'vitest';
import { attentionFor, shortlistCandidates, SHORTLIST_TARGET_SIZE } from '../src/reaction/candidate-shortlist';
import { generatePersonaV3 } from '../src/personas/generator-v3';
import { ReactionBotCandidate } from '../src/reaction/types';
import { StreamEvent } from '../src/stream-brain/types';

// generatePersonaV3 only accepts usernames from a fixed, finite blueprint catalog, and this suite
// needs many distinct fixture candidates by arbitrary name — so one real generated persona is cloned
// per candidate instead. attentionFor/shortlistCandidates never read persona.id or a name embedded
// in the persona itself, only behavior/interests/knowledge, so which blueprint this comes from does
// not matter.
const BASE_PERSONA = generatePersonaV3('karlbekner');

function candidate(username: string, overrides: (persona: ReactionBotCandidate['persona']) => void = () => undefined): ReactionBotCandidate {
  const persona = structuredClone(BASE_PERSONA);
  persona.behavior.activity.preferredEventTypes = [];
  persona.behavior.activity.ignoredEventTypes = [];
  persona.interests = { games: [], music: [], food: [], other: [] };
  persona.knowledge.expertise = [];
  persona.knowledge.familiarTopics = [];
  overrides(persona);
  return { username, persona, enabled: true, connectionState: 'CONNECTED', chatConnected: true };
}

function streamEvent(overrides: Partial<StreamEvent> = {}): StreamEvent {
  return {
    id: 'event-1', timestamp: 1_000, type: 'gameplay', summary: 'стример катает рейтинговую игру в доту',
    importance: 0.5, confidence: 0.9, source: 'gemini-live', directMentions: [], ...overrides,
  };
}

describe('attentionFor', () => {
  it('notices when the event type is in the persona\'s own preferredEventTypes', () => {
    const c = candidate('a', (p) => { p.behavior.activity.preferredEventTypes = ['gameplay']; });
    expect(attentionFor(c.persona, streamEvent({ summary: 'ничего общего с интересами' }))).toBe('notices');
  });

  it('passes over when the event type is in ignoredEventTypes, even if the summary would otherwise match an interest', () => {
    const c = candidate('a', (p) => {
      p.behavior.activity.ignoredEventTypes = ['gameplay'];
      p.interests.games = ['доту'];
    });
    expect(attentionFor(c.persona, streamEvent({ summary: 'стример катает доту' }))).toBe('passes over');
  });

  it('notices via a topical token match against interests when the event type matches neither list', () => {
    const c = candidate('a', (p) => { p.interests.games = ['доту']; });
    expect(attentionFor(c.persona, streamEvent({ summary: 'стример катает доту весь вечер' }))).toBe('notices');
  });

  it('notices via a topical token match against knowledge.expertise', () => {
    const c = candidate('a', (p) => { p.knowledge.expertise = ['кулинария']; });
    expect(attentionFor(c.persona, streamEvent({ summary: 'стример готовит ужин, кулинария сегодня в моде' }))).toBe('notices');
  });

  it('falls back to no strong pattern when nothing matches at all', () => {
    const c = candidate('a');
    expect(attentionFor(c.persona, streamEvent({ summary: 'стример катает доту весь вечер' }))).toBe('no strong pattern');
  });
});

describe('shortlistCandidates', () => {
  it('is a no-op when the pool is already at or below the target size', () => {
    const candidates = [candidate('a'), candidate('b')];
    const result = shortlistCandidates(candidates, streamEvent(), 8);
    expect(result.shortlisted).toEqual(candidates);
    expect(result.reduced).toBe(false);
  });

  it('never truncates the notices tier, even past the target size', () => {
    const noticing = ['a', 'b', 'c', 'd'].map((name) => candidate(name, (p) => { p.interests.games = ['доту']; }));
    const filler = ['e', 'f', 'g', 'h', 'i'].map((name) => candidate(name));
    const result = shortlistCandidates([...noticing, ...filler], streamEvent({ summary: 'стример катает доту' }), 3);
    const shortlistedUsernames = result.shortlisted.map((c) => c.username);
    expect(shortlistedUsernames).toEqual(expect.arrayContaining(['a', 'b', 'c', 'd']));
    expect(result.reduced).toBe(true);
  });

  it('fills padding up to the target size, ranked by chatFrequency x reactionProbability', () => {
    const strong = candidate('strong', (p) => {
      p.behavior.activity.chatFrequency = 'high';
      p.behavior.reactionProbability = 0.9;
    });
    const weak = candidate('weak', (p) => {
      p.behavior.activity.chatFrequency = 'very-low';
      p.behavior.reactionProbability = 0.1;
    });
    const middling = Array.from({ length: 5 }, (_, index) => candidate(`middling-${index}`, (p) => {
      p.behavior.activity.chatFrequency = 'medium';
      p.behavior.reactionProbability = 0.5;
    }));
    const result = shortlistCandidates([weak, ...middling, strong], streamEvent(), 3);
    const shortlistedUsernames = result.shortlisted.map((c) => c.username);
    expect(shortlistedUsernames).toContain('strong');
    expect(shortlistedUsernames).not.toContain('weak');
    expect(result.shortlisted).toHaveLength(3);
  });

  it('excludes passes-over candidates from padding', () => {
    const ignoring = candidate('ignoring', (p) => { p.behavior.activity.ignoredEventTypes = ['gameplay']; });
    const neutral = candidate('neutral');
    const result = shortlistCandidates([ignoring, neutral], streamEvent(), 1);
    expect(result.shortlisted.map((c) => c.username)).toEqual(['neutral']);
  });

  it('keeps the attention of every input candidate, including ones the shortlist did not keep', () => {
    const kept = candidate('kept', (p) => { p.interests.games = ['доту']; });
    const dropped = candidate('dropped');
    const result = shortlistCandidates([kept, dropped], streamEvent({ summary: 'стример катает доту' }), 1);
    expect(result.shortlisted.map((c) => c.username)).toEqual(['kept']);
    expect(result.attentionByUsername.get('kept')).toBe('notices');
    expect(result.attentionByUsername.get('dropped')).toBe('no strong pattern');
  });

  it('passing the full pool size as targetSize keeps everyone — how a direct mention bypasses trimming', () => {
    const candidates = Array.from({ length: 12 }, (_, index) => candidate(`user-${index}`));
    const result = shortlistCandidates(candidates, streamEvent(), candidates.length);
    expect(result.shortlisted).toHaveLength(12);
    expect(result.reduced).toBe(false);
  });

  it('preserves the caller\'s original candidate order in the shortlisted output, not the tier order', () => {
    // Equal chatFrequency/reactionProbability on both filler candidates makes the padding pick
    // deterministic by username tie-break ('a-filler' over 'b-filler'), so only the ordering claim
    // is actually under test here, not which candidate the ranking happens to prefer.
    const evenFiller = (p: ReactionBotCandidate['persona']): void => {
      p.behavior.activity.chatFrequency = 'medium';
      p.behavior.reactionProbability = 0.5;
    };
    const noticing = candidate('z-notices', (p) => { p.interests.games = ['доту']; });
    const fillerA = candidate('a-filler', evenFiller);
    const fillerB = candidate('b-filler', evenFiller);
    // Padding-eligible candidates placed before the notices candidate in the input: if the
    // implementation output tier order (notices first) instead of input order, this would catch it.
    const result = shortlistCandidates([fillerA, fillerB, noticing], streamEvent({ summary: 'стример катает доту' }), 2);
    expect(result.shortlisted.map((c) => c.username)).toEqual(['a-filler', 'z-notices']);
  });

  it('exports a default target size', () => {
    expect(SHORTLIST_TARGET_SIZE).toBeGreaterThan(0);
  });
});
