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
   * introduced these accounts to anybody, so the first-message gate must still be up.
   */
  hasSentAiMessage: boolean;
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
  now?: () => number;
  newId?: () => string;
}

const DEFAULT_CONTINUITY_GRACE_MS = 15 * 60_000;

export class StreamSession {
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly continuityGraceMs: number;
  private current?: StreamSessionSnapshot;
  private lastActiveAt = 0;

  constructor(options: StreamSessionOptions = {}) {
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? (() => Math.random().toString(36).slice(2, 12));
    this.continuityGraceMs = options.continuityGraceMs ?? DEFAULT_CONTINUITY_GRACE_MS;
  }

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
   * queued reaction, not one the policy guard accepted and the sender then failed to deliver.
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

  /** True while no account has managed to say anything yet this session. */
  isColdStart(): boolean { return this.current ? !this.current.hasSentAiMessage : true; }

  private continues(broadcastId: string | undefined, now: number): boolean {
    if (!this.current) return false;
    const known = this.current.broadcastId;
    if (broadcastId && known) return broadcastId === known;
    // Without an id on one side or the other, continuity is a judgement about the gap. An operator
    // pause is seconds; a streamlink restart is seconds; the next evening is hours.
    return now - this.lastActiveAt <= this.continuityGraceMs;
  }
}
