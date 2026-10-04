import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface BackupInfo {
  name: string;
  sizeBytes: number;
  createdAt: string;
}

/** Default: a backup is not removed to make room until it is at least this old, however many newer ones exist. */
export const MIN_KEEP_DAYS = 7;

export interface BackupSettings {
  /** Most backups to keep. Once a new one pushes the count over this, the oldest go. */
  keep: number;
  /** A backup younger than this many days is never removed for room. 0 means the count alone decides. */
  minDays: number;
  /** Automatic backup interval in hours. 0 turns automatic backups off. */
  everyHours: number;
}

export function parseSettings(v: unknown, fallback: BackupSettings): BackupSettings {
  const o = (v ?? {}) as Partial<Record<keyof BackupSettings, unknown>>;
  const int = (x: unknown, lo: number, hi: number, d: number) => (typeof x === "number" && Number.isInteger(x) && x >= lo && x <= hi ? x : d);
  return { keep: int(o.keep, 1, 100, fallback.keep), minDays: int(o.minDays, 0, 365, fallback.minDays), everyHours: int(o.everyHours, 0, 720, fallback.everyHours) };
}
const DAY_MS = 24 * 60 * 60 * 1000;

/** What it takes to set a server up again from one of its backups. Kept beside the backups, since the server's own record is deleted with it. */
export interface ServerMeta {
  name: string;
  templateId: string;
  env: Record<string, string>;
  access: "private" | "public";
  hideIp: boolean;
}

const SLUG = /^[a-z0-9][a-z0-9-]*$/;

const NAME = /^[a-z0-9][a-z0-9-]*-\d{8}-\d{6}(-\d+)?\.tar\.gz$/;
export const isBackupName = (name: string) => NAME.test(name);

function tar(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn("tar", args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) => reject(new Error(`could not run tar: ${e.message}`)));
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`tar failed (${code}): ${err.trim().split("\n").slice(-2).join(" ")}`))));
  });
}

const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "").replace("T", "-");

/**
 * Compressed copies of a server's data folder, kept in `<gameservers>/.backups/<slug>/`.
 * Backups live outside the data folder, so deleting a server or its data never deletes its backups. Only a newer
 * backup of the same server can push an old one out, and only once it is beyond the newest `keep` and at least
 * `minDays` old (both settable per server; 7 and 7 by default). Backups of a deleted server are never pruned.
 */
export class BackupStore {
  private readonly defaults: BackupSettings;

  constructor(
    private readonly root: string,
    keep = 7,
    /** Paths inside a server's data folder that its backups leave out (big files the game downloads again by itself). */
    private readonly excludeFor: (slug: string) => string[] = () => [],
  ) {
    this.defaults = { keep, minDays: MIN_KEEP_DAYS, everyHours: 24 };
  }

  /** Per-server settings live beside the backups, so they survive deleting and recreating the server. */
  settings(slug: string): BackupSettings {
    try {
      return parseSettings(JSON.parse(readFileSync(path.join(this.dir(slug), "settings.json"), "utf8")), this.defaults);
    } catch {
      return this.defaults;
    }
  }

  setSettings(slug: string, input: unknown): BackupSettings {
    const o = (input ?? {}) as Record<string, unknown>;
    const next = parseSettings(input, this.settings(slug));
    if ((o.keep !== undefined && next.keep !== o.keep) || (o.minDays !== undefined && next.minDays !== o.minDays) || (o.everyHours !== undefined && next.everyHours !== o.everyHours)) {
      throw new Error("keep must be a whole number from 1 to 100, days from 0 to 365, and hours from 0 to 720");
    }
    mkdirSync(this.dir(slug), { recursive: true });
    writeFileSync(path.join(this.dir(slug), "settings.json"), JSON.stringify(next));
    return next;
  }

  private dir(slug: string) {
    if (!SLUG.test(slug)) throw new Error("not a valid server name");
    return path.join(this.root, ".backups", slug);
  }

  /** Every server (current or deleted) that has a backup folder. */
  slugs(): string[] {
    const dir = path.join(this.root, ".backups");
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && SLUG.test(e.name))
      .map((e) => e.name);
  }

  meta(slug: string): ServerMeta | null {
    try {
      const o = JSON.parse(readFileSync(path.join(this.dir(slug), "server.json"), "utf8")) as Partial<ServerMeta>;
      if (typeof o.name !== "string" || typeof o.templateId !== "string") return null;
      const env = Object.fromEntries(Object.entries(o.env ?? {}).filter(([, v]) => typeof v === "string")) as Record<string, string>;
      // Servers backed up before Hide my IP was its own switch were saved with access "relay".
      const legacyRelay = (o.access as string) === "relay";
      return { name: o.name, templateId: o.templateId, env, access: o.access === "public" ? "public" : "private", hideIp: o.hideIp === true || legacyRelay };
    } catch {
      return null;
    }
  }

  /** Written only when it changed. The file holds the server's passwords, so only this process can read it. */
  setMeta(slug: string, meta: ServerMeta) {
    const file = path.join(this.dir(slug), "server.json");
    const json = JSON.stringify(meta);
    if (existsSync(file) && readFileSync(file, "utf8") === json) return;
    mkdirSync(this.dir(slug), { recursive: true });
    writeFileSync(file, json, { mode: 0o600 });
  }

  private file(slug: string, name: string) {
    if (!isBackupName(name) || !name.startsWith(`${slug}-`)) throw new Error("not a backup of this server");
    return path.join(this.dir(slug), name);
  }

  list(slug: string): BackupInfo[] {
    const dir = this.dir(slug);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((n) => isBackupName(n) && n.startsWith(`${slug}-`))
      .map((name) => {
        const st = statSync(path.join(dir, name));
        return { name, sizeBytes: st.size, createdAt: st.mtime.toISOString() };
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.name.localeCompare(a.name));
  }

  /** `prune: false` keeps every backup (used for the safety copy before a restore, which must not evict the one being restored). */
  async create(slug: string, opts: { now?: Date; prune?: boolean } = {}): Promise<BackupInfo> {
    const now = opts.now ?? new Date();
    if (!existsSync(path.join(this.root, slug))) throw new Error("this server has no data folder yet");
    const dir = this.dir(slug);
    mkdirSync(dir, { recursive: true });
    let name = `${slug}-${stamp(now)}.tar.gz`;
    for (let n = 2; existsSync(path.join(dir, name)); n++) name = `${slug}-${stamp(now)}-${n}.tar.gz`;
    const tmp = path.join(dir, `.${name}.partial`);
    try {
      await tar(["-czf", tmp, "--anchored", ...this.excludeFor(slug).map((x) => `--exclude=${slug}/${x}`), "-C", this.root, slug]);
      renameSync(tmp, path.join(dir, name));
    } catch (e) {
      rmSync(tmp, { force: true });
      throw e;
    }
    if (opts.prune !== false) {
      const { keep, minDays } = this.settings(slug);
      const cutoff = now.getTime() - minDays * DAY_MS;
      for (const old of this.list(slug).slice(keep)) {
        if (minDays === 0 || new Date(old.createdAt).getTime() <= cutoff) rmSync(path.join(dir, old.name), { force: true });
      }
    }
    return this.list(slug).find((b) => b.name === name)!;
  }

  remove(slug: string, name: string) {
    const f = this.file(slug, name);
    if (!existsSync(f)) throw new Error("backup not found");
    rmSync(f);
  }

  /**
   * Replace a data folder with the backup. The old folder is only removed once the new one is in place.
   * `target` is the folder to restore into; it defaults to the backed-up server's own, and differs when a deleted server is set up again under a new name.
   */
  async restore(slug: string, name: string, now = Date.now(), target = slug): Promise<void> {
    if (!SLUG.test(target)) throw new Error("not a valid server name");
    const f = this.file(slug, name);
    if (!existsSync(f)) throw new Error("backup not found");
    const tmp = path.join(this.root, `.restore-${target}`);
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });
    try {
      await tar(["-xzf", f, "-C", tmp]);
      if (!existsSync(path.join(tmp, slug))) throw new Error("the backup does not contain this server's data");
      const live = path.join(this.root, target);
      const aside = path.join(this.root, `.old-${target}-${now}`);
      if (existsSync(live)) renameSync(live, aside);
      try {
        renameSync(path.join(tmp, slug), live);
      } catch (e) {
        if (existsSync(aside)) renameSync(aside, live); // put the old data back
        throw e;
      }
      // What backups leave out is not in the backup, so it is carried over from the folder being replaced. If that fails the game downloads it again.
      for (const x of this.excludeFor(target)) {
        try {
          const old = path.join(aside, x);
          if (existsSync(old) && !existsSync(path.join(live, x))) {
            mkdirSync(path.dirname(path.join(live, x)), { recursive: true });
            renameSync(old, path.join(live, x));
          }
        } catch {
          /* best effort */
        }
      }
      rmSync(aside, { recursive: true, force: true });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
}
