import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import type { Db } from "./db/index.js";
import { schema } from "./db/index.js";

const REPO = "LordMerc/self-hosted-game-labs";
const API_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const RELEASE_URL_PREFIX = `https://github.com/${REPO}/`;

const K_ENABLED = "update_check_enabled";
const K_RESULT = "update_check_result";

const DAY_MS = 24 * 60 * 60 * 1000;
const RETRY_MS = 60 * 60 * 1000;
/** "Check now" on the Settings page is allowed this often at most. */
const MANUAL_MIN_MS = 60 * 1000;

/** The version this build reports: set by the published image, otherwise the one in package.json. */
export function runningVersion(fromEnv: string): string {
  if (fromEnv.trim()) return fromEnv.trim();
  try {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

type Parsed = { nums: [number, number, number]; pre: string | null };

export function parseVersion(v: string): Parsed | null {
  const m = v.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/);
  return m ? { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? null } : null;
}

/** Positive when `a` is newer than `b`. */
export function compareVersions(a: Parsed, b: Parsed): number {
  for (let i = 0; i < 3; i++) if (a.nums[i] !== b.nums[i]) return a.nums[i] - b.nums[i];
  if (a.pre === b.pre) return 0;
  if (a.pre === null) return 1; // 1.0.0 is newer than 1.0.0-rc.1
  if (b.pre === null) return -1;
  return a.pre < b.pre ? -1 : 1;
}

interface Stored {
  checkedAt: number;
  ok: boolean;
  tag?: string;
  name?: string;
  url?: string;
  publishedAt?: string;
  error?: string;
}

export interface UpdateState {
  /** Whether the daily check is switched on (the Settings toggle, unless UPDATE_CHECK=off overrides it). */
  enabled: boolean;
  /** `env` when UPDATE_CHECK=off in the environment, so the toggle cannot turn it on. */
  lockedByEnv: boolean;
  /** The running version, as reported by the build. */
  current: string;
  /** False for development builds, which have no release number to compare. */
  comparable: boolean;
  latest: { version: string; name: string; url: string; publishedAt: string | null } | null;
  updateAvailable: boolean;
  checkedAt: string | null;
  error: string | null;
}

export class UpdateChecker {
  constructor(
    private readonly db: Db,
    private readonly opts: { current: string; envEnabled: boolean; fetchFn?: typeof fetch; now?: () => number },
  ) {}

  private get now() {
    return (this.opts.now ?? Date.now)();
  }

  private get(key: string): string | null {
    return this.db.select().from(schema.settings).where(eq(schema.settings.key, key)).get()?.value ?? null;
  }

  private set(key: string, value: string) {
    this.db.insert(schema.settings).values({ key, value }).onConflictDoUpdate({ target: schema.settings.key, set: { value } }).run();
  }

  private stored(): Stored | null {
    try {
      return JSON.parse(this.get(K_RESULT) ?? "null") as Stored | null;
    } catch {
      return null;
    }
  }

  get enabled(): boolean {
    return this.opts.envEnabled && this.get(K_ENABLED) !== "off";
  }

  setEnabled(on: boolean): void {
    this.set(K_ENABLED, on ? "on" : "off");
  }

  state(): UpdateState {
    const s = this.stored();
    const current = parseVersion(this.opts.current);
    const latestParsed = s?.tag ? parseVersion(s.tag) : null;
    const enabled = this.enabled;
    return {
      enabled,
      lockedByEnv: !this.opts.envEnabled,
      current: this.opts.current,
      comparable: current !== null,
      latest: s?.tag && s.url ? { version: s.tag.replace(/^v/, ""), name: s.name || s.tag, url: s.url, publishedAt: s.publishedAt ?? null } : null,
      updateAvailable: enabled && current !== null && latestParsed !== null && compareVersions(latestParsed, current) > 0,
      checkedAt: s ? new Date(s.checkedAt).toISOString() : null,
      error: s && !s.ok ? (s.error ?? "check failed") : null,
    };
  }

  /** Runs the check if it is switched on, the build has a release number, and the last one is old enough. Safe to call often. */
  async checkIfDue(): Promise<void> {
    if (!this.enabled || parseVersion(this.opts.current) === null) return;
    const s = this.stored();
    if (s && this.now - s.checkedAt < (s.ok ? DAY_MS : RETRY_MS)) return;
    await this.fetchLatest();
  }

  /** The Settings page's "Check now". Returns false when the last check was under a minute ago. */
  async checkNow(): Promise<boolean> {
    if (!this.enabled || parseVersion(this.opts.current) === null) return false;
    const s = this.stored();
    if (s && this.now - s.checkedAt < MANUAL_MIN_MS) return false;
    await this.fetchLatest();
    return true;
  }

  /** Only anonymous GET of public release data: nothing about this machine is sent besides the program name and version. */
  private async fetchLatest(): Promise<void> {
    const at = this.now;
    try {
      const res = await (this.opts.fetchFn ?? fetch)(API_URL, {
        headers: { accept: "application/vnd.github+json", "user-agent": `self-hosted-game-labs/${this.opts.current}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
      const body = (await res.json()) as { tag_name?: unknown; name?: unknown; html_url?: unknown; published_at?: unknown };
      const tag = typeof body.tag_name === "string" ? body.tag_name : "";
      const url = typeof body.html_url === "string" ? body.html_url : "";
      if (!parseVersion(tag)) throw new Error("the latest release has no version number");
      // Only ever link to this project's own release pages.
      if (!url.startsWith(RELEASE_URL_PREFIX)) throw new Error("the release link was not on github.com");
      const stored: Stored = {
        checkedAt: at,
        ok: true,
        tag,
        url,
        name: typeof body.name === "string" && body.name ? body.name.slice(0, 120) : tag,
        publishedAt: typeof body.published_at === "string" ? body.published_at : undefined,
      };
      this.set(K_RESULT, JSON.stringify(stored));
    } catch (e) {
      const prev = this.stored();
      // Keep the last good answer so a flaky network does not hide a known update.
      const failed: Stored = { ...(prev?.ok ? prev : {}), checkedAt: at, ok: false, error: e instanceof Error ? e.message : String(e) };
      this.set(K_RESULT, JSON.stringify(failed));
    }
  }
}
