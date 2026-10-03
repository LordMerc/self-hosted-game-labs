import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "./db/index.js";
import * as schema from "./db/schema.js";

/**
 * Per-server upkeep settings: a daily restart, image updates, and which image the server runs.
 * Kept as one JSON value per server in the `settings` table (key `care-<server id>`), so no migration is needed.
 */

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a time like 04:30");

export const WARN_CHOICES = [0, 1, 5, 10, 15] as const;

export const careSchema = z
  .object({
    restart: z
      .object({
        enabled: z.boolean().default(false),
        time: hhmm.default("04:00"),
        /** Minutes before the restart to tell players in the game (0 = no warning). Only for games with a broadcast command. */
        warnMinutes: z
          .number()
          .int()
          .refine((n) => (WARN_CHOICES as readonly number[]).includes(n), "Choose 0, 1, 5, 10 or 15 minutes")
          .default(5),
      })
      .strict()
      .default({ enabled: false, time: "04:00", warnMinutes: 5 }),
    update: z
      .object({
        /** Every day at `time`, look for a newer image and, if there is one, back up and switch to it. */
        auto: z.boolean().default(false),
        time: hhmm.default("05:00"),
      })
      .strict()
      .default({ auto: false, time: "05:00" }),
  })
  .strict();
export type CareSettings = z.infer<typeof careSchema>;

export const defaultCare = (): CareSettings => careSchema.parse({});

/** What the panel remembers between visits: which image the server was moved to, and the last update check. */
export interface CareState {
  /** Image the server runs instead of the template's (set when a newer tag is applied). */
  image: string | null;
  lastRestartOn: string | null;
  lastUpdateOn: string | null;
  check: UpdateCheck | null;
}

export interface UpdateCheck {
  checkedAt: string;
  available: boolean;
  /** `tag`: a newer version tag exists. `image`: the same tag now points at a different image. */
  via: "tag" | "image";
  current: string;
  latest: string | null;
  /** Plain-language result, shown as is. */
  note: string;
}

interface Stored {
  settings: CareSettings;
  state: CareState;
}

const emptyState = (): CareState => ({ image: null, lastRestartOn: null, lastUpdateOn: null, check: null });

export class CareStore {
  constructor(private readonly db: Db) {}

  private key = (serverId: string) => `care-${serverId}`;

  private load(serverId: string): Stored {
    const row = this.db.select().from(schema.settings).where(eq(schema.settings.key, this.key(serverId))).get();
    if (!row) return { settings: defaultCare(), state: emptyState() };
    try {
      const raw = JSON.parse(row.value) as { settings?: unknown; state?: Partial<CareState> };
      const parsed = careSchema.safeParse(raw.settings ?? {});
      return { settings: parsed.success ? parsed.data : defaultCare(), state: { ...emptyState(), ...(raw.state ?? {}) } };
    } catch {
      return { settings: defaultCare(), state: emptyState() };
    }
  }

  private save(serverId: string, v: Stored) {
    const value = JSON.stringify(v);
    this.db
      .insert(schema.settings)
      .values({ key: this.key(serverId), value })
      .onConflictDoUpdate({ target: schema.settings.key, set: { value } })
      .run();
  }

  settings(serverId: string): CareSettings {
    return this.load(serverId).settings;
  }

  state(serverId: string): CareState {
    return this.load(serverId).state;
  }

  setSettings(serverId: string, input: unknown): CareSettings {
    const cur = this.load(serverId);
    const parsed = careSchema.safeParse(input);
    if (!parsed.success) throw new Error(parsed.error.issues[0].message);
    this.save(serverId, { ...cur, settings: parsed.data });
    return parsed.data;
  }

  patchState(serverId: string, patch: Partial<CareState>): CareState {
    const cur = this.load(serverId);
    const state = { ...cur.state, ...patch };
    this.save(serverId, { ...cur, state });
    return state;
  }

  drop(serverId: string) {
    this.db.delete(schema.settings).where(eq(schema.settings.key, this.key(serverId))).run();
  }
}

// -------------------------------------------------------------- schedule

/** Local calendar day as YYYY-MM-DD (the panel's time zone, see TZ). */
export const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Today's moment for a "HH:MM" time. */
export function todayAt(time: string, now: Date): Date {
  const [h, m] = time.split(":").map(Number);
  const d = new Date(now);
  d.setHours(h, m, 0, 0);
  return d;
}

/** A job that missed its time (the panel was down) still runs if it is at most this late; after that it waits for tomorrow. */
export const CATCH_UP_MS = 60 * 60 * 1000;

export interface Due {
  /** The time has come and the job has not run today. */
  now: boolean;
  /** Whole minutes left until today's time, when it is still ahead and has not run today; otherwise null. */
  minutesLeft: number | null;
}

export function dueStatus(time: string, now: Date, lastRunOn: string | null): Due {
  if (lastRunOn === dayKey(now)) return { now: false, minutesLeft: null };
  const at = todayAt(time, now).getTime();
  const t = now.getTime();
  if (t < at) return { now: false, minutesLeft: Math.ceil((at - t) / 60_000) };
  return { now: t - at <= CATCH_UP_MS, minutesLeft: null };
}

// -------------------------------------------------------------- versions

/** The tag part of an image name (`repo/name:v1.2.3` gives `v1.2.3`; no tag means `latest`). */
export function tagOf(image: string): string {
  const last = image.slice(image.lastIndexOf("/") + 1);
  const i = last.indexOf(":");
  return i === -1 ? "latest" : last.slice(i + 1);
}

/** The image name without its tag. */
export function repoOf(image: string): string {
  const slash = image.lastIndexOf("/");
  const i = image.indexOf(":", slash + 1);
  return i === -1 ? image : image.slice(0, i);
}

/** Compare version tags such as `v2.8.0` by their numbers. Negative when a is older than b. */
export function compareVersions(a: string, b: string): number {
  const nums = (s: string) => (s.match(/\d+/g) ?? []).map(Number);
  const x = nums(a);
  const y = nums(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** The newest tag that matches the pattern, or null. */
export function newestTag(tags: string[], pattern: string): string | null {
  const re = new RegExp(pattern);
  const ok = tags.filter((t) => re.test(t));
  if (ok.length === 0) return null;
  return ok.reduce((best, t) => (compareVersions(t, best) > 0 ? t : best));
}

/** Docker Hub image names have no registry host in front (`user/name`, or a bare official name). Anything else is not looked up. */
export function isDockerHubImage(image: string): boolean {
  const repo = repoOf(image);
  const first = repo.split("/")[0];
  return !repo.includes("/") || !(first.includes(".") || first.includes(":") || first === "localhost");
}

export type TagLister = (repo: string) => Promise<string[]>;

/** Lists recent tags of a Docker Hub repository (anonymous, one request). */
export const dockerHubTags: TagLister = async (repo) => {
  const name = repo.includes("/") ? repo : `library/${repo}`;
  const res = await fetch(`https://hub.docker.com/v2/repositories/${name}/tags?page_size=100&ordering=last_updated`, { signal: AbortSignal.timeout(15_000), headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`Docker Hub answered ${res.status}`);
  const body = (await res.json()) as { results?: { name?: string }[] };
  return (body.results ?? []).map((r) => r.name ?? "").filter(Boolean);
};
