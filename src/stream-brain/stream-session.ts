/**
 * Which evening this is, as distinct from which processing run this is.
 *
 * These were the same thing until a live run showed what that costs. The bootstrap asked the usage
 * tracker when the stream began, and the usage tracker restarts its clock on every media
 * transition — including the one an operator causes by pausing and resuming. So a fifteen-second
 * pause mid-broadcast produced `currentSessionEvents: 0` and a bootstrap reason of `stream_start`:
 * the same evening, re-entered as a stranger, and the first message after it was the usual
 * cold-start default. A rollover, which does not touch that clock, kept all 25 events — same code,
 * different clock, opposite result.
 *
 * This owns the other clock. It survives an operator pause, a media reconnect and a Brain rollover,
 * and it ends only when the broadcast does.
 */
export type SessionContinuity = 'new' | 'resumed';

export interface StreamSessionSnapshot {
  id: string;
  startedAt: number;
  /** Twitch's own id for the broadcast, when Helix has answered. The best evidence available. */
  broadcastId?: string;
  /**
   * Whether any account has actually put a message in chat this session. Deliberately not "the
   * Brain chose one" or "the guard accepted one": a decision that never reached Twitch has not
   * introduced these accounts to anybody, so the strict cold-start bar must still apply to the next
   * attempt.
   */
  hasSentAiMessage: boolean;
}

/**
 * Two independent facts about a session, read together but never conflated.
 *
 * `hasSentAiMessage` is permanent once true: it means these accounts have spoken, full stop.
 * `active` is a clock: it is true only for the configured window from the start of the evening,
 * and it turns itself off on a timer regardless of whether anything was ever sent. A live run
 * produced `hasSentAiMessage=false, active=false` for the last three and a half minutes of an
 * eleven-minute session before this existed — the accounts had said nothing, and nothing was
 * stopping them from saying something ordinary the moment a moment came along, except that no
 * moment before the seventh minute cleared the standing elevated bar.
 */
export interface ColdStartStatus {
  /** Whether the strict first-message quality bar is currently in force. */
  active: boolean;
  /** Milliseconds since the session began. Not milliseconds since the first observation — see below. */
  ageMs: number;
  /** The configured window length. */
  windowMs: number;
  hasSentAiMessage: boolean;
  /** True once the window has elapsed with nothing sent. A state, checked whenever asked, not an edge. */
  expired: boolean;
}

export interface StreamSessionOptions {
  /**
   * How long a gap may be before an unidentified broadcast counts as a different one.
   *
   * Only consulted when Twitch has not told us the broadcast id — with an id there is nothing to
   * guess. Wide enough to cover an operator applying settings, a streamlink restart or a CDN
   * hiccup; far short of the gap between two evenings.
   */
  continuityGraceMs?: number;
  /**
   * How long the strict first-message quality bar stays up after the evening starts, if nothing has
   * been sent yet.
   *
   * Measured against a real run rather than guessed: scene description runs on a 25-second cycle
   * and the speech pipeline needs a 12-second window, but on the run that motivated this, the first
   * scene description landed 12 milliseconds after the session began — the pipeline captures its
   * first frame immediately and only settles into the 25-second cadence afterward. So the window is
   * measured from the session's own start rather than from a separately-tracked "first observation":
   * the two are close enough in practice that tracking the second one would add a state that can, in
   * a genuinely silent pipeline, simply never arrive — which would leave the strict bar up forever,
   * exactly the failure this exists to end. Sixty seconds is several multiples of that 12–25 second
   * observation cadence, so a real chat is not spending most of the window waiting for its first
   * look at the stream; it is the number of seconds a weak first message may be held back, not the
   * number of seconds before the pipeline has anything to react to.
   */
  coldStartWindowMs?: number;
  now?: () => number;
  newId?: () => string;
}

const DEFAULT_CONTINUITY_GRACE_MS = 15 * 60_000;
const DEFAULT_COLD_START_WINDOW_MS = 60_000;

export class StreamSession {
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly continuityGraceMs: number;
  private readonly coldStartWindowMs: number;
  private current?: StreamSessionSnapshot;
  private lastActiveAt = 0;

  constructor(options: StreamSessionOptions = {}) {
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? (() => Math.random().toString(36).slice(2, 12));
    this.continuityGraceMs = options.continuityGraceMs ?? DEFAULT_CONTINUITY_GRACE_MS;
    this.coldStartWindowMs = options.coldStartWindowMs ?? DEFAULT_COLD_START_WINDOW_MS;
  }

  /** The configured strict-window length, for logging and for scheduling the one-shot expiry check. */
  get coldStartWindow(): number { return this.coldStartWindowMs; }

  /**
   * Media is streaming again. Answers whether this continues the evening or starts one, and the
   * answer decides what the Brain is told it has already seen.
   */
  begin(broadcastId?: string): { session: StreamSessionSnapshot; continuity: SessionContinuity } {
    const now = this.now();
    const continuity = this.continues(broadcastId, now) ? 'resumed' : 'new';
    if (continuity === 'resumed' && this.current) {
      // A broadcast id arriving late attaches to the session already running rather than replacing
      // it: Helix is polled on a timer, so the first minutes of an evening often have no id at all.
      if (broadcastId && !this.current.broadcastId) this.current = { ...this.current, broadcastId };
    } else {
      this.current = {
        id: this.newId(),
        startedAt: now,
        ...(broadcastId ? { broadcastId } : {}),
        hasSentAiMessage: false,
      };
    }
    this.lastActiveAt = now;
    return { session: { ...this.current }, continuity };
  }

  /**
   * Twitch named the broadcast. A different id than the one this session started under is the only
   * unambiguous evidence that the evening changed, and it ends the session even mid-flight.
   */
  observeBroadcast(broadcastId: string | undefined): void {
    if (!broadcastId || !this.current) return;
    if (this.current.broadcastId === undefined) {
      this.current = { ...this.current, broadcastId };
      return;
    }
    if (this.current.broadcastId !== broadcastId) this.current = undefined;
  }

  /** Something was observed. Keeps the grace window measured from activity, not from session start. */
  touch(): void { this.lastActiveAt = this.now(); }

  /**
   * A message reached Twitch. Only this clears the first-message gate — not a decision, not a
   * queued reaction, not one the policy guard accepted and the sender then failed to deliver, and
   * not one the naturalness guard threw out as commentary rather than a reaction.
   */
  markMessageSent(): void {
    if (!this.current || this.current.hasSentAiMessage) return;
    this.current = { ...this.current, hasSentAiMessage: true };
    this.lastActiveAt = this.now();
  }

  /** The broadcast is over as far as this process can tell. A later begin() starts a new evening. */
  end(): void {
    this.current = undefined;
    this.lastActiveAt = 0;
  }

  snapshot(): StreamSessionSnapshot | undefined {
    return this.current ? { ...this.current } : undefined;
  }

  /**
   * Whether the strict first-message bar is up right now. Cheap and pure — this is called on every
   * stream-event and Persona Drive opportunity, so it does no more than a subtraction and a compare.
   *
   * Time-bounded on purpose. The bar exists because the first thing these accounts say has no
   * established voice behind it; it does not exist to let a session hold every account silent
   * indefinitely while it waits for a first moment good enough to clear an unbounded standard. A
   * live run went seven minutes and twelve seconds — eighteen stream-event decisions and three
   * Persona Drive calls, every one of them returning complete silence — because nothing bounded how
   * long "wait for a better one" was allowed to remain true. This bounds it.
   */
  isStrictColdStart(): boolean {
    if (!this.current) return true;
    if (this.current.hasSentAiMessage) return false;
    return this.now() - this.current.startedAt < this.coldStartWindowMs;
  }

  /** The full diagnostic picture: what `isStrictColdStart()` collapses to one bit, without hiding the rest. */
  coldStartStatus(): ColdStartStatus {
    if (!this.current) {
      return { active: true, ageMs: 0, windowMs: this.coldStartWindowMs, hasSentAiMessage: false, expired: false };
    }
    const ageMs = Math.max(0, this.now() - this.current.startedAt);
    const hasSentAiMessage = this.current.hasSentAiMessage;
    return {
      active: !hasSentAiMessage && ageMs < this.coldStartWindowMs,
      ageMs,
      windowMs: this.coldStartWindowMs,
      hasSentAiMessage,
      expired: !hasSentAiMessage && ageMs >= this.coldStartWindowMs,
    };
  }

  private continues(broadcastId: string | undefined, now: number): boolean {
    if (!this.current) return false;
    const known = this.current.broadcastId;
    if (broadcastId && known) return broadcastId === known;
    // Without an id on one side or the other, continuity is a judgement about the gap. An operator
    // pause is seconds; a streamlink restart is seconds; the next evening is hours.
    return now - this.lastActiveAt <= this.continuityGraceMs;
  }
}
