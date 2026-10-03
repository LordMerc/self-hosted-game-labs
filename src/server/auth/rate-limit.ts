/** Fixed-window limiter for login attempts, keyed by client IP. In-memory is fine: single process. */
export class LoginRateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly max = 5,
    private readonly windowMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Returns true if the attempt is allowed (and counts it). */
  attempt(key: string): boolean {
    const t = this.now();
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= t) {
      this.hits.set(key, { count: 1, resetAt: t + this.windowMs });
      return true;
    }
    entry.count++;
    return entry.count <= this.max;
  }

  reset(key: string): void {
    this.hits.delete(key);
  }
}
