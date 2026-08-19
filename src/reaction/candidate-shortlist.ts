import { CHAT_FREQUENCY_WEIGHT } from '../personas/chat-frequency-weight';
import { relevanceScore, semanticTokens } from '../personas/persona-memory';
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
  const activity = persona.behavior.activity;
  if (activity.ignoredEventTypes.includes(event.type)) return 'passes over';
  if (activity.preferredEventTypes.includes(event.type)) return 'notices';
  const moment = semanticTokens([event.summary, event.speech, event.visualContext, event.gameContext]
    .filter(Boolean).join(' '));
  if (moment.size === 0) return 'no strong pattern';
  const subjects = [
    ...persona.interests.games, ...persona.interests.music,
    ...persona.interests.food, ...persona.interests.other,
    ...persona.knowledge.expertise, ...persona.knowledge.familiarTopics,
  ];
  return subjects.some((subject) => relevanceScore(moment, subject) > 0)
    ? 'notices'
    : 'no strong pattern';
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

export interface ShortlistResult {
  /** The candidates actually offered to the Brain — a subset of the input, same order otherwise. */
  shortlisted: ReactionBotCandidate[];
  /** Every eligible candidate's attention, including those the shortlist did not keep — for stats. */
  attentionByUsername: Map<string, CandidateAttention>;
  /** True when the shortlist actually removed someone. False on an already-small pool. */
  reduced: boolean;
}

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
): ShortlistResult {
  const attentionByUsername = new Map(
    candidates.map((candidate) => [candidate.username, attentionFor(candidate.persona, event)] as const),
  );
  if (candidates.length <= targetSize) {
    return { shortlisted: candidates, attentionByUsername, reduced: false };
  }

  const notices = candidates.filter((candidate) => attentionByUsername.get(candidate.username) === 'notices');
  const padCandidates = candidates.filter((candidate) => attentionByUsername.get(candidate.username) === 'no strong pattern');
  const padCount = Math.max(0, targetSize - notices.length);
  const padded = padCandidates
    .map((candidate) => ({ candidate, score: baselineActivityScore(candidate.persona) }))
    .sort((left, right) => right.score - left.score || left.candidate.username.localeCompare(right.candidate.username))
    .slice(0, padCount)
    .map(({ candidate }) => candidate);

  const keep = new Set([...notices, ...padded].map((candidate) => candidate.username));
  // Preserve the caller's original ordering rather than the tier order, so downstream code that
  // assumes "same relative order as `candidates`" keeps working unchanged.
  const shortlisted = candidates.filter((candidate) => keep.has(candidate.username));
  return { shortlisted, attentionByUsername, reduced: shortlisted.length < candidates.length };
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
