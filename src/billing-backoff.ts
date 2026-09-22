/** Billing failures cannot recover by immediately resubmitting the next stream segment. */
export function isBillingFailure(cause: unknown): boolean {
  const message = cause instanceof Error ? cause.message : String(cause);
  return /\b402\b|prepayment|credits are depleted|insufficient (?:funds|balance|credit)|requires at least.*balance|add more credits/iu.test(message);
}

export class BillingBackoff {
  retryAt = 0;
  revision = 0;
  private probing = false;
  constructor(private readonly now: () => number = Date.now, private readonly delayMs = 5 * 60_000) {}
  acquire(): boolean {
    if (!this.retryAt) return true;
    if (this.now() < this.retryAt || this.probing) return false;
    this.probing = true;
    return true;
  }
  success(revision = this.revision): void {
    if (revision !== this.revision) return;
    this.retryAt = 0; this.probing = false;
  }
  failure(cause: unknown): void {
    if (isBillingFailure(cause) || this.probing) {
      this.retryAt = this.now() + this.delayMs;
      this.revision += 1;
    }
    this.probing = false;
  }
}
