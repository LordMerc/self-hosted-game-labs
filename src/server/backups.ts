import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";

export interface BackupInfo {
  name: string;
  sizeBytes: number;
  createdAt: string;
}

/** A backup is never removed to make room until it is at least this old, however many newer ones exist. */
export const MIN_KEEP_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

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
 * MIN_KEEP_DAYS old. Backups of a deleted server are never pruned.
 */
export class BackupStore {
  constructor(
    private readonly root: string,
    private readonly keep = 7,
  ) {}

  private dir(slug: string) {
    return path.join(this.root, ".backups", slug);
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
      await tar(["-czf", tmp, "-C", this.root, slug]);
      renameSync(tmp, path.join(dir, name));
    } catch (e) {
      rmSync(tmp, { force: true });
      throw e;
    }
    if (opts.prune !== false) {
      const cutoff = now.getTime() - MIN_KEEP_DAYS * DAY_MS;
      for (const old of this.list(slug).slice(this.keep)) {
        if (new Date(old.createdAt).getTime() <= cutoff) rmSync(path.join(dir, old.name), { force: true });
      }
    }
    return this.list(slug).find((b) => b.name === name)!;
  }

  remove(slug: string, name: string) {
    const f = this.file(slug, name);
    if (!existsSync(f)) throw new Error("backup not found");
    rmSync(f);
  }

  /** Replace the server's data folder with the backup. The old folder is only removed once the new one is in place. */
  async restore(slug: string, name: string, now = Date.now()): Promise<void> {
    const f = this.file(slug, name);
    if (!existsSync(f)) throw new Error("backup not found");
    const tmp = path.join(this.root, `.restore-${slug}`);
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });
    try {
      await tar(["-xzf", f, "-C", tmp]);
      if (!existsSync(path.join(tmp, slug))) throw new Error("the backup does not contain this server's data");
      const live = path.join(this.root, slug);
      const aside = path.join(this.root, `.old-${slug}-${now}`);
      if (existsSync(live)) renameSync(live, aside);
      try {
        renameSync(path.join(tmp, slug), live);
      } catch (e) {
        if (existsSync(aside)) renameSync(aside, live); // put the old data back
        throw e;
      }
      rmSync(aside, { recursive: true, force: true });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
}
