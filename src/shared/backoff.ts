export class ExponentialBackoff {
  private attempt = 0;

  constructor(
    private readonly minimumMs = 1000,
    private readonly maximumMs = 60_000,
    private readonly jitter = 0.2,
    private readonly random: () => number = Math.random,
  ) {}

  next(): number {
    const base = Math.min(this.maximumMs, this.minimumMs * 2 ** this.attempt);
    this.attempt += 1;
    const variation = base * this.jitter * (this.random() * 2 - 1);
    return Math.max(0, Math.round(base + variation));
  }

  reset(): void { this.attempt = 0; }
}

export function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new Error('Aborted'));
    }, { once: true });
  });
}
