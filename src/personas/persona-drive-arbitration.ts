import { relevanceScore, semanticTokens } from './persona-memory';
import { ChatMessage, StreamEvent } from '../stream-brain/types';

export type DriveArbitrationOutcome = 'valid' | 'expired' | 'duplicate' | 'superseded';

export interface DriveArbitrationResult {
  outcome: DriveArbitrationOutcome;
  /** The fact from during generation that decided a non-valid outcome — the content an
   *  unconditional discard used to throw away without ever being logged. */
  reason?: string;
}

export interface DriveArbitrationInput {
  reaction: { username: string; message: string };
  /**
   * When the Brain call for this reaction was issued. Deliberately not "when the subject was last
   * observed" — Persona Drive routinely fires after minutes of quiet, and a subject being old is
   * exactly the case it is allowed to speak about ("a subject from a minute ago" is fine by the
   * Brain's own instruction). What arbitration polices is only the generation window itself: what
   * arrived between asking and answering. Both the TTL and the "since" filter below are measured
   * from here, never from how fresh the topic happened to be when generation started.
   */
  generationStartedAt: number;
  /** What the drive's own payload said the moment was about: its recentSpeech, recentEvents and
   *  recentChat, already reduced to plain text. The topic-overlap check compares against this,
   *  not against a re-derived guess, so it can only disagree with what the Brain actually saw. */
  hookSubjectText: string;
  now: number;
  /** The session's current view — filtered internally to what postdates generationStartedAt.
   *  Passing the full snapshot arrays rather than pre-filtered ones keeps the ">" comparison in
   *  one place. */
  recentChat: ChatMessage[];
  recentEvents: StreamEvent[];
}

/**
 * How long a generation round trip gets before its own age is reason enough to drop it, regardless
 * of content. Real calls run 4–6s; thirty seconds is roughly five times that — past any ordinary
 * network hiccup, into "this call stalled or retried" territory. Anchored to when the call was
 * issued, not to the subject's own age, so a drive opportunity that fired after minutes of quiet
 * (routine — the drive is gated on quiet, not on freshness) is never penalised for the quiet itself.
 */
export const HOOK_TTL_MS = 30_000;

/**
 * The importance floor above which an intervening event counts as a real pivot rather than filler.
 * Not a new number: `ReactionPolicyGuard.maxReactionsFor` already treats 0.6 as the line between "at
 * most one voice" and "more than one voice is warranted" for a stream event, so an event below it is
 * already, elsewhere in this codebase, treated as ordinary. Reusing it here means a live run's two
 * real cancellations — 'speech' events at importance 0.4 and 0.5, both unrelated small talk — land
 * where they actually belong: below the bar, not above it.
 */
const SUPERSEDING_IMPORTANCE = 0.6;

/**
 * How much of a reaction's own words have to already appear in something said during generation
 * before it reads as a repeat rather than a coincidence. `relevanceScore` scores a near-identical
 * short message against itself at roughly 1; one accidental shared word out of several scores well
 * under 0.3. Half is past "shares a topic" and into "says the same thing".
 */
const DUPLICATE_RELEVANCE_THRESHOLD = 0.5;

/**
 * Whether a Persona Drive reaction that finished generating after real events kept arriving is still
 * worth sending.
 *
 * The rule this replaces was `if (anything arrived while Gemini was thinking) discard` — content
 * never entered into it. A live run showed exactly what that costs: two spontaneous replies, four and
 * five seconds into generation, thrown away because an unrelated 'speech' event of importance 0.4 or
 * 0.5 happened to land in the same window. Neither event had anything to do with what the drive was
 * about to say. This function reads what actually arrived instead of only noticing that something did:
 *
 *  - `expired`  — generation itself ran long (`HOOK_TTL_MS` since `generationStartedAt`), independent
 *    of whether anything happened. A stalled call is reason enough on its own.
 *  - `duplicate` — someone (a viewer or another bot) already said essentially this, during generation.
 *  - `superseded` — an intervening event scored `importance >= SUPERSEDING_IMPORTANCE` and shares no
 *    vocabulary at all with what the drive's own payload was about — a real pivot elsewhere, not a
 *    second event about the same thing.
 *  - `valid` — none of the above. Sent even though something happened in the meantime, because
 *    nothing that happened makes it wrong.
 *
 * Order matters: age is checked first because it needs nothing else to be true, then duplicate before
 * superseded because saying something already said is wrong regardless of how important anything else
 * was.
 */
export function arbitrateDriveReaction(input: DriveArbitrationInput): DriveArbitrationResult {
  const age = input.now - input.generationStartedAt;
  if (age > HOOK_TTL_MS) {
    return { outcome: 'expired', reason: `generation age ${age}ms exceeds ${HOOK_TTL_MS}ms` };
  }

  const sinceGeneration = input.generationStartedAt;
  const chatSince = input.recentChat.filter((message) => message.timestamp > sinceGeneration);
  const reactionTokens = semanticTokens(input.reaction.message);
  const duplicate = chatSince.find(
    (message) => relevanceScore(reactionTokens, message.message) >= DUPLICATE_RELEVANCE_THRESHOLD,
  );
  if (duplicate) {
    return { outcome: 'duplicate', reason: `matches chat from ${duplicate.username} at ${duplicate.timestamp}` };
  }

  const eventsSince = input.recentEvents.filter((event) => event.timestamp > sinceGeneration);
  const hookTokens = semanticTokens(input.hookSubjectText);
  const superseding = eventsSince.find((event) => {
    if (event.importance < SUPERSEDING_IMPORTANCE) return false;
    const text = [event.summary, event.speech, event.visualContext, event.gameContext].filter(Boolean).join(' ');
    return relevanceScore(hookTokens, text) === 0;
  });
  if (superseding) {
    return {
      outcome: 'superseded',
      reason: `unrelated event '${superseding.type}' importance ${superseding.importance} at ${superseding.timestamp}`,
    };
  }

  return { outcome: 'valid' };
}
