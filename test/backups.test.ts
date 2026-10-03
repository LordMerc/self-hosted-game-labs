import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
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

  it("never prunes a backup younger than 7 days, even beyond the newest N", async () => {
    const s = new BackupStore(root, 2);
    for (const h of [1, 2, 3, 4]) await s.create("pal", { now: new Date(`2026-10-03T0${h}:00:00Z`) });
    expect(s.list("pal")).toHaveLength(4);
  });

  it("prunes only backups beyond the newest N that are at least 7 days old", async () => {
    const s = new BackupStore(root, 2);
    const old = await s.create("pal", { now: new Date("2026-10-03T01:00:00Z") });
    const mid = await s.create("pal", { now: new Date("2026-10-03T02:00:00Z") });
    const kept = await s.create("pal", { now: new Date("2026-10-03T03:00:00Z") });
    const dir = path.join(root, ".backups/pal");
    const ago = (days: number) => new Date(Date.now() - days * 86_400_000);
    utimesSync(path.join(dir, old.name), ago(9), ago(9));
    utimesSync(path.join(dir, mid.name), ago(3), ago(3)); // beyond N=2 but only 3 days old
    await s.create("pal", { now: new Date() });
    const names = s.list("pal").map((b) => b.name);
    expect(names).not.toContain(old.name);
    expect(names).toContain(mid.name);
    expect(names).toContain(kept.name);
  });

  it("with 0 days, the count alone decides: the oldest goes when a new one pushes it over the limit", async () => {
    const s = new BackupStore(root);
    expect(s.settings("pal")).toEqual({ keep: 7, minDays: 7, everyHours: 24 });
    s.setSettings("pal", { keep: 2, minDays: 0 });
    const names: string[] = [];
    for (const h of [1, 2, 3]) names.push((await s.create("pal", { now: new Date(`2026-10-03T0${h}:00:00Z`) })).name);
    const left = s.list("pal").map((b) => b.name);
    expect(left).toHaveLength(2);
    expect(left).not.toContain(names[0]);
  });

  it("stores settings per server, keeps the other field when only one is sent, and rejects nonsense", () => {
    const s = new BackupStore(root);
    s.setSettings("pal", { keep: 5, minDays: 3 });
    expect(s.setSettings("pal", { keep: 4 })).toEqual({ keep: 4, minDays: 3, everyHours: 24 });
    expect(new BackupStore(root).settings("pal")).toEqual({ keep: 4, minDays: 3, everyHours: 24 });
    expect(s.settings("other")).toEqual({ keep: 7, minDays: 7, everyHours: 24 });
    for (const bad of [{ keep: 0 }, { keep: 101 }, { keep: "5" }, { minDays: -1 }, { minDays: 1.5 }, { everyHours: -1 }, { everyHours: 721 }]) expect(() => s.setSettings("pal", bad)).toThrow(/whole number/);
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

  it("keeps a server's saved settings private and lists every server that has a backup folder", async () => {
    const s = new BackupStore(root);
    await s.create("pal");
    expect(s.meta("pal")).toBeNull();
    s.setMeta("pal", { name: "Pal", templateId: "palworld", env: { X: "1" }, access: "public" });
    expect(s.meta("pal")).toEqual({ name: "Pal", templateId: "palworld", env: { X: "1" }, access: "public" });
    expect(statSync(path.join(root, ".backups/pal/server.json")).mode & 0o077).toBe(0);
    expect(s.slugs()).toEqual(["pal"]);
    expect(() => s.list("../etc")).toThrow(/not a valid/);
  });

  it("can restore a backup into a different server name", async () => {
    const s = new BackupStore(root);
    const b = await s.create("pal");
    await s.restore("pal", b.name, Date.now(), "pal-2");
    expect(readFileSync(path.join(root, "pal-2/Saved/world.sav"), "utf8")).toBe("v1");
    expect(existsSync(path.join(root, "pal/Saved/world.sav"))).toBe(true);
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
