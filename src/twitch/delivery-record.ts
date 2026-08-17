export interface AccountDeliveryRecord {
  username: string;
  /** Messages Twitch accepted from this account. */
  sent: number;
  /** Of those, how many the reader account saw come back, so the channel really showed them. */
  shown: number;
  /** Accepted without error and never shown — Twitch dropped them silently. */
  hidden: number;
  /** Refused outright, with the reason Twitch gave on that account's own connection. */
  refused: number;
  lastReason?: string;
  lastShownAt?: number;
  lastHiddenAt?: number;
}

export interface DeliveryRecordSnapshot {
  /** Whether an account is currently reading chat; without one nothing can be judged at all. */
  observing: boolean;
  accounts: AccountDeliveryRecord[];
}

/**
 * Which accounts the channel actually shows, learned from the messages they were already sending.
 *
 * The active check this replaces had all thirty accounts post a bare number two seconds apart, and
 * measurement turned out to cost the thing it measured: on 17 August nineteen accounts delivered at
 * 11:55, the check ran, and by 12:13 the same accounts were down to four — the sequence is
 * indistinguishable from a spam raid, and Twitch restricts for about a day. Yesterday's four had
 * recovered overnight to nineteen, which is what made the cause visible at all.
 *
 * Real traffic answers the same question for free. Every reaction is already watched for its echo
 * through the reader account, so the verdict per account accumulates on its own, with nothing extra
 * ever sent.
 */
export class DeliveryRecord {
  private readonly accounts = new Map<string, AccountDeliveryRecord>();

  constructor(private readonly options: { observesChat?: () => boolean; now?: () => number } = {}) {}

  recordSent(username: string): void {
    this.entry(username).sent += 1;
  }

  recordShown(username: string): void {
    const entry = this.entry(username);
    entry.shown += 1;
    entry.lastShownAt = this.now();
  }

  recordHidden(username: string, reason?: string): void {
    const entry = this.entry(username);
    if (reason) {
      entry.refused += 1;
      entry.lastReason = reason;
    } else {
      entry.hidden += 1;
    }
    entry.lastHiddenAt = this.now();
  }

  /**
   * Worst first: an account whose messages never appear is the one worth knowing about, and an
   * account nobody has selected yet says nothing either way.
   */
  snapshot(): DeliveryRecordSnapshot {
    const accounts = [...this.accounts.values()]
      .map((entry) => ({ ...entry }))
      .sort((left, right) => (left.shown - left.hidden - left.refused)
        - (right.shown - right.hidden - right.refused)
        || right.sent - left.sent
        || left.username.localeCompare(right.username));
    return { observing: this.options.observesChat?.() ?? false, accounts };
  }

  private entry(username: string): AccountDeliveryRecord {
    const key = username.toLowerCase();
    const existing = this.accounts.get(key);
    if (existing) return existing;
    const created: AccountDeliveryRecord = { username, sent: 0, shown: 0, hidden: 0, refused: 0 };
    this.accounts.set(key, created);
    return created;
  }

  private now(): number { return this.options.now?.() ?? Date.now(); }
}
