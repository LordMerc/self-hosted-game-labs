/**
 * Slows down password guessing. In memory is fine: there is one process, and a restart clears nothing an attacker can trigger.
 *
 * - Each visitor (by address) may fail a few times; after that they are locked out, for longer each time it happens again.
 * - All visitors together are capped too, so guessing from many addresses at once does not get around the first rule.
 * - A correct password clears that visitor's record. While locked out, even the right password is refused.
 */
export interface LoginGuardOptions {
  /** Failures from one visitor before they are locked out. */
  maxFailures?: number;
  /** How far back failures count. */
  windowMs?: number;
  /** First lockout; each repeat within `forgetMs` doubles it, up to `maxLockMs`. */
  lockMs?: number;
  maxLockMs?: number;
  /** A visitor with no failures for this long is forgotten, including their repeat count. */
  forgetMs?: number;
  /** Failures from everyone together (within the window) before all sign-ins pause. */
  globalMaxFailures?: number;
  globalLockMs?: number;
  now?: () => number;
}

export type GuardResult = { allowed: true } | { allowed: false; retryAfterSec: number; scope: "visitor" | "panel" };

interface Entry {
  failures: number[];
  lockedUntil: number;
  strikes: number;
  lastSeen: number;
}

const MAX_TRACKED = 10_000;

export class LoginGuard {
  private entries = new Map<string, Entry>();
  private globalFailures: number[] = [];
  private globalLockedUntil = 0;
  private readonly o: Required<Omit<LoginGuardOptions, "now">>;
  private readonly now: () => number;

  constructor(options: LoginGuardOptions = {}) {
    this.o = {
      maxFailures: options.maxFailures ?? 5,
      windowMs: options.windowMs ?? 15 * 60_000,
      lockMs: options.lockMs ?? 15 * 60_000,
      maxLockMs: options.maxLockMs ?? 4 * 60 * 60_000,
      forgetMs: options.forgetMs ?? 24 * 60 * 60_000,
      globalMaxFailures: options.globalMaxFailures ?? 30,
      globalLockMs: options.globalLockMs ?? 5 * 60_000,
    };
    this.now = options.now ?? Date.now;
  }

  /** Ask before checking a password. */
  check(key: string): GuardResult {
    const t = this.now();
    if (this.globalLockedUntil > t) return { allowed: false, scope: "panel", retryAfterSec: Math.ceil((this.globalLockedUntil - t) / 1000) };
    const e = this.entries.get(key);
    if (e && e.lockedUntil > t) return { allowed: false, scope: "visitor", retryAfterSec: Math.ceil((e.lockedUntil - t) / 1000) };
    return { allowed: true };
  }

  /** Record a wrong password. */
  fail(key: string): void {
    const t = this.now();
    this.prune(t);

    this.globalFailures = this.globalFailures.filter((at) => at > t - this.o.windowMs);
    this.globalFailures.push(t);
    if (this.globalFailures.length >= this.o.globalMaxFailures) {
      this.globalLockedUntil = t + this.o.globalLockMs;
      this.globalFailures = [];
    }

    const e = this.entries.get(key) ?? { failures: [], lockedUntil: 0, strikes: 0, lastSeen: t };
    e.lastSeen = t;
    e.failures = e.failures.filter((at) => at > t - this.o.windowMs);
    e.failures.push(t);
    if (e.failures.length >= this.o.maxFailures) {
      e.lockedUntil = t + Math.min(this.o.lockMs * 2 ** e.strikes, this.o.maxLockMs);
      e.strikes++;
      e.failures = [];
    }
    this.entries.set(key, e);
  }

  /** Record a correct password. */
  succeed(key: string): void {
    this.entries.delete(key);
  }

  private prune(t: number): void {
    if (this.entries.size < MAX_TRACKED) return;
    for (const [k, e] of this.entries) if (e.lockedUntil <= t && e.lastSeen < t - this.o.forgetMs) this.entries.delete(k);
    // Still full of recent visitors: drop the oldest rather than grow without bound.
    while (this.entries.size >= MAX_TRACKED) this.entries.delete(this.entries.keys().next().value as string);
  }
}

/**
 * One key per visitor. IPv6 visitors usually control a whole /64, so they are grouped by it; otherwise a single
 * machine could try a fresh address for every guess.
 */
export function visitorKey(ip: string): string {
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) return mapped[1];
  if (!ip.includes(":")) return ip;
  const [head] = ip.split("%");
  const [left, right = ""] = head.split("::");
  const leftParts = left ? left.split(":") : [];
  const rightParts = right ? right.split(":") : [];
  const missing = 8 - leftParts.length - rightParts.length;
  const groups = head.includes("::") ? [...leftParts, ...Array<string>(Math.max(0, missing)).fill("0"), ...rightParts] : leftParts;
  return `${groups.slice(0, 4).map((g) => g.toLowerCase().replace(/^0+(?=.)/, "")).join(":")}::/64`;
}
