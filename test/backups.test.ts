import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { BackupStore, isBackupName } from "../src/server/backups.js";

let root: string;
const write = (rel: string, text: string) => {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  writeFileSync(path.join(root, rel), text);
};

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "gl-bk-"));
  write("pal/Saved/world.sav", "v1");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("BackupStore", () => {
  it("creates a backup outside the data folder and lists it newest first", async () => {
    const s = new BackupStore(root);
    const a = await s.create("pal", { now: new Date("2026-10-03T01:00:00Z") });
    const b = await s.create("pal", { now: new Date("2026-10-03T01:00:00Z") }); // same second: name must not collide
    expect(a.name).toBe("pal-20261003-010000.tar.gz");
    expect(b.name).toBe("pal-20261003-010000-2.tar.gz");
    expect(a.sizeBytes).toBeGreaterThan(0);
    expect(existsSync(path.join(root, ".backups/pal", a.name))).toBe(true);
    expect(s.list("pal").map((x) => x.name)).toContain(a.name);
    expect(s.list("other")).toEqual([]);
  });

  it("keeps only the newest N", async () => {
    const s = new BackupStore(root, 2);
    for (const h of [1, 2, 3]) await s.create("pal", { now: new Date(`2026-10-03T0${h}:00:00Z`) });
    expect(s.list("pal")).toHaveLength(2);
    expect(s.list("pal").some((b) => b.name.includes("-010000"))).toBe(false);
  });

  it("does not prune when asked not to", async () => {
    const s = new BackupStore(root, 1);
    for (const h of [1, 2]) await s.create("pal", { now: new Date(`2026-10-03T0${h}:00:00Z`), prune: false });
    expect(s.list("pal")).toHaveLength(2);
  });

  it("restores the old contents and removes files created after the backup", async () => {
    const s = new BackupStore(root);
    const b = await s.create("pal");
    write("pal/Saved/world.sav", "v2");
    write("pal/Saved/new.txt", "added later");
    await s.restore("pal", b.name);
    expect(readFileSync(path.join(root, "pal/Saved/world.sav"), "utf8")).toBe("v1");
    expect(existsSync(path.join(root, "pal/Saved/new.txt"))).toBe(false);
    expect(readdirNames(root)).toEqual([".backups", "pal"]);
  });

  it("refuses names that are not backups of this server, and a missing data folder", async () => {
    const s = new BackupStore(root);
    expect(isBackupName("../../etc/passwd")).toBe(false);
    expect(() => s.remove("pal", "../x-20261003-010000.tar.gz")).toThrow();
    expect(() => s.remove("pal", "other-20261003-010000.tar.gz")).toThrow(/not a backup of this server/);
    await expect(s.restore("pal", "pal-20261003-010000.tar.gz")).rejects.toThrow(/not found/);
    await expect(s.create("ghost")).rejects.toThrow(/no data folder/);
  });

  it("leaves the live data alone when the archive is bad", async () => {
    const s = new BackupStore(root);
    mkdirSync(path.join(root, ".backups/pal"), { recursive: true });
    writeFileSync(path.join(root, ".backups/pal/pal-20261003-010000.tar.gz"), "not a tarball");
    await expect(s.restore("pal", "pal-20261003-010000.tar.gz")).rejects.toThrow(/tar failed/);
    expect(readFileSync(path.join(root, "pal/Saved/world.sav"), "utf8")).toBe("v1");
  });
});

import { readdirSync } from "node:fs";
const readdirNames = (dir: string) => readdirSync(dir).sort();
