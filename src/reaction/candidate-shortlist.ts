import { CHAT_FREQUENCY_WEIGHT } from '../personas/chat-frequency-weight';
import { topicRelevance, topicTokens } from '../shared/topics';
import { StreamEvent } from '../stream-brain/types';
import { ReactionBotCandidate } from './types';

export type CandidateAttention = 'notices' | 'passes over' | 'no strong pattern';

/**
 * Whether this moment is one this character would look at.
 *
 * Matching `event.type` against the profile's own event labels sounded right and did nothing. The
 * two vocabularies barely meet: the catalogue calls things 'football', 'dota-analysis', 'gossip',
 * 'music', 'routine', while the perception layer emits 'speech', 'question', 'conversation',
 * 'visual'. Across a measured stream that left `attention` at 'no strong pattern' for 28 of 31
 * moments and identical for all four accounts on the other three — a fit signal that never once
 * told two candidates apart, while the numeric selectivity beside it suppressed all of them.
 *
 * What the profiles do carry in the same language as the stream is what the person is into, so a
 * topical hit on interests or expertise is the signal that actually fires. The event-type lists are
 * still honoured where they happen to line up.
 */
export function attentionFor(persona: ReactionBotCandidate['persona'], event: StreamEvent): CandidateAttention {
  const score = topicalScore(persona, event);
  if (score < 0) return 'passes over';
  return score > 0 ? 'notices' : 'no strong pattern';
}

/**
 * How strongly this moment reads as being for this character: -1 for a declared-ignored event
 * type, 0 for no signal, otherwise the best topical relevance of any of their interests or
 * knowledge against the moment. The number the shortlist ranks its topic tier by — "likes Dota"
 * and "knows Dota deeply, and the moment is about exactly that" stopped being the same seat once
 * an ordinary Dota sentence started making nineteen of twenty-nine personas equally 'relevant'.
 */
export function topicalScore(persona: ReactionBotCandidate['persona'], event: StreamEvent): number {
  const activity = persona.behavior.activity;
  if (activity.ignoredEventTypes.includes(event.type)) return -1;
  const momentText = [event.summary, event.speech, event.visualContext, event.gameContext]
    .filter(Boolean).join(' ');
  let best = 0;
  if (topicTokens(momentText).size > 0) {
    const subjects = [
      ...persona.interests.games, ...persona.interests.music,
      ...persona.interests.food, ...persona.interests.other,
      ...persona.knowledge.expertise, ...persona.knowledge.familiarTopics,
    ];
    // The shared topic yardstick, not raw token overlap: an interest written "Dota 2" must notice
    // a stream that says «доту», or the channel's main subject never counts as anyone's.
    for (const subject of subjects) best = Math.max(best, topicRelevance(momentText, subject));
  }
  // A preferred event type is a real signal but a generic one; it ranks below any actual topical
  // match (canonical matches floor at 0.3) while still clearing zero.
  if (best === 0 && activity.preferredEventTypes.includes(event.type)) best = 0.15;
  return best;
}

/**
 * How many candidates a moment is shown to, before shortlisting trims the rest.
 *
 * Chosen from this project's own history rather than a round number: the last run where nobody
 * complained about reaction quality ran at 7.76–7.94 average candidates per decision. Below this,
 * shortlisting is a no-op — there is nothing to trim, and a small stream should never look narrower
 * than it already is.
 */
export const SHORTLIST_TARGET_SIZE = 8;

/** Why a candidate holds their seat — inspectable, so "why did 19 enter the Brain" is a query. */
export type ShortlistReason = 'direct' | 'personal' | 'topic' | 'padding';

export interface ShortlistSignals {
  /**
   * The candidate's own living state pressed against this moment: the best relevance of any open
   * curiosity, unresolved loop or active life concern. Above PERSONAL_STRONG_MIN the seat is
   * mandatory — a person whose own unfinished thought this moment answers must not be the one
   * trimmed for room. Optional; absent means no personal tier, the pre-mind behavior.
   */
  personalRelevance?: (username: string) => number;
  /** Lowercase usernames the event addresses directly. Always kept, labeled as such. */
  direct?: ReadonlySet<string>;
}

export interface ShortlistResult {
  /** The candidates actually offered to the Brain — a subset of the input, same order otherwise. */
  shortlisted: ReactionBotCandidate[];
  /** Every eligible candidate's attention, including those the shortlist did not keep — for stats. */
  attentionByUsername: Map<string, CandidateAttention>;
  /** Why each OFFERED candidate holds the seat. */
  reasonByUsername: Map<string, ShortlistReason>;
  /** Topically relevant candidates that did NOT fit — the number that says the trim is working. */
  trimmedRelevant: number;
  /** True when the shortlist actually removed someone. False on an already-small pool. */
  reduced: boolean;
}

/**
 * A curiosity, loop or concern has to genuinely bear on the moment to make its holder mandatory;
 * matches the canonical-topic floor so an explicit registry hit on one's own open material counts.
 */
export const PERSONAL_STRONG_MIN = 0.3;

/**
 * Twenty-nine distinct people is not twenty-nine equally plausible respondents to one ordinary
 * remark, and handing the Brain all twenty-nine as a flat, mostly-identical list is not neutral —
 * it is noise. A measured run showed why: 449 attention checks across one session, 63 'notices' and
 * the rest 'no strong pattern' — roughly one candidate in seven carrying any topical signal at all,
 * the other six read as interchangeable filler on every single decision. This is what a real chat
 * does implicitly and what the backend can do explicitly: put the people an event is actually for in
 * front of the Brain, and fill any remaining room with a plausible general audience — never with
 * "whoever has been quiet".
 *
 * Two tiers, unconditionally kept, then padding:
 *  1. `attention === 'notices'` — topical fit, from the character's own interests and expertise.
 *     Never truncated: if a moment genuinely lands with twelve of twenty-nine people, showing the
 *     Brain all twelve is correct, not overload — `constraints.maxReactions` still governs how many
 *     of them may actually speak.
 *  2. Padding, up to `targetSize`, ranked by a deterministic baseline — declared chattiness ×
 *     canonical reactionProbability, the same two fields Persona Drive already uses to weight whom
 *     to offer a spontaneous moment to. Never `sessionMessageCount`, never idle time: a prior for
 *     who plausibly speaks at all is not a queue for whose turn it is.
 *
 * `attention === 'passes over'` candidates never fill padding — their own profile says this kind of
 * moment is not for them — and by the same token they can never be in tier 1 either, since
 * `ignoredEventTypes` is checked first inside `attentionFor` and returns before the topical match
 * ever runs: a canon that lists a type as usually ignored is trusted on that, not second-guessed by a
 * coincidental interest keyword.
 *
 * A directly-mentioned account must never be the one trimmed for room — leaving a question addressed
 * to someone unanswered is worse than a crowded payload. `ReactionCoordinator.prepareBrainEvent`
 * enforces this by calling in with `targetSize = candidates.length` for a direct-mention event, which
 * makes the size guard above a structural no-op: every named candidate is already `<= targetSize`,
 * so nobody reaches the trimming logic at all.
 */
export function shortlistCandidates(
  candidates: ReactionBotCandidate[],
  event: StreamEvent,
  targetSize = SHORTLIST_TARGET_SIZE,
  signals: ShortlistSignals = {},
): ShortlistResult {
  const scores = new Map(candidates.map((candidate) =>
    [candidate.username, topicalScore(candidate.persona, event)] as const));
  const attentionByUsername = new Map(candidates.map((candidate) => {
    const score = scores.get(candidate.username)!;
    return [candidate.username, score < 0 ? 'passes over' as const : score > 0 ? 'notices' as const : 'no strong pattern' as const];
  }));

  const reasonFor = (candidate: ReactionBotCandidate): ShortlistReason => {
    if (signals.direct?.has(candidate.username.toLowerCase())) return 'direct';
    if ((signals.personalRelevance?.(candidate.username) ?? 0) >= PERSONAL_STRONG_MIN
      && attentionByUsername.get(candidate.username) !== 'passes over') return 'personal';
    return attentionByUsername.get(candidate.username) === 'notices' ? 'topic' : 'padding';
  };

  if (candidates.length <= targetSize) {
    const reasonByUsername = new Map(candidates.map((candidate) => [candidate.username, reasonFor(candidate)] as const));
    return { shortlisted: candidates, attentionByUsername, reasonByUsername, trimmedRelevant: 0, reduced: false };
  }

  // MANDATORY seats: a direct address, or a moment that lands on this person's own open material —
  // an unresolved loop, an open curiosity, a live concern. Kept even past the target: a small soft
  // overflow when several genuinely mandatory candidates exist beats trimming the one person the
  // moment is actually for. NOT mandatory: liking the topic. Nineteen people who like Dota is not
  // nineteen people an ordinary Dota sentence is for, and that live spike (offered 17–21 against a
  // target of 8) is exactly what the ranked tier below now absorbs.
  const mandatory = candidates.filter((candidate) => {
    const reason = reasonFor(candidate);
    return reason === 'direct' || reason === 'personal';
  });
  const mandatoryNames = new Set(mandatory.map((candidate) => candidate.username));

  // RANKABLE topical seats fill the room that is left, best fit first: actual topical relevance,
  // then the same baseline prior padding uses. Relevance-based, never fairness — the order is who
  // the moment reads as being for, not who has waited.
  const topical = candidates
    .filter((candidate) => !mandatoryNames.has(candidate.username)
      && attentionByUsername.get(candidate.username) === 'notices')
    .map((candidate) => ({ candidate, score: scores.get(candidate.username)!, baseline: baselineActivityScore(candidate.persona) }))
    .sort((left, right) => right.score - left.score || right.baseline - left.baseline
      || left.candidate.username.localeCompare(right.candidate.username));
  const topicalRoom = Math.max(0, targetSize - mandatory.length);
  const keptTopical = topical.slice(0, topicalRoom).map(({ candidate }) => candidate);
  const trimmedRelevant = Math.max(0, topical.length - keptTopical.length);

  const padCount = Math.max(0, targetSize - mandatory.length - keptTopical.length);
  const padded = candidates
    .filter((candidate) => !mandatoryNames.has(candidate.username)
      && attentionByUsername.get(candidate.username) === 'no strong pattern')
    .map((candidate) => ({ candidate, score: baselineActivityScore(candidate.persona) }))
    .sort((left, right) => right.score - left.score || left.candidate.username.localeCompare(right.candidate.username))
    .slice(0, padCount)
    .map(({ candidate }) => candidate);

  const keep = new Set([...mandatory, ...keptTopical, ...padded].map((candidate) => candidate.username));
  // Preserve the caller's original ordering rather than the tier order, so downstream code that
  // assumes "same relative order as `candidates`" keeps working unchanged.
  const shortlisted = candidates.filter((candidate) => keep.has(candidate.username));
  const reasonByUsername = new Map(shortlisted.map((candidate) => [candidate.username, reasonFor(candidate)] as const));
  return {
    shortlisted, attentionByUsername, reasonByUsername, trimmedRelevant,
    reduced: shortlisted.length < candidates.length,
  };
}

/**
 * A backend-only prior, never shown to the model: how likely this persona is to be a plausible
 * general-audience pick when nothing marks them as specifically fit. Deliberately excludes
 * eventSelectivity — a global "how choosy" number already failed twice as a payload field for
 * double-suppressing candidates the backend had already cleared, and reusing it here to decide who
 * even gets *offered* the moment would be the same mistake at a different layer.
 */
function baselineActivityScore(persona: ReactionBotCandidate['persona']): number {
  return CHAT_FREQUENCY_WEIGHT[persona.behavior.activity.chatFrequency] * persona.behavior.reactionProbability;
}
