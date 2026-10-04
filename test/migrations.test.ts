import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/server/db/index.js";

describe("hide_ip migration", () => {
  it("turns servers stored with access relay into private servers with Hide my IP on, and leaves the rest alone", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "gl-mig-"));
    const file = path.join(dir, "panel.db");

    // Build the database as it was before the migration: only the first three are applied.
    const old = path.join(dir, "old-migrations");
    cpSync(path.resolve("drizzle"), old, { recursive: true });
    const journalPath = path.join(old, "meta", "_journal.json");
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: { tag: string }[] };
    journal.entries = journal.entries.filter((e) => e.tag !== "0003_hide_ip");
    writeFileSync(journalPath, JSON.stringify(journal));
    const before = openDb(file, old);
    before.sqlite.prepare("INSERT INTO servers (id, slug, name, template_id, access, created_at) VALUES (?, ?, ?, ?, ?, ?)").run("a", "a", "A", "x", "relay", 1);
    before.sqlite.prepare("INSERT INTO servers (id, slug, name, template_id, access, created_at) VALUES (?, ?, ?, ?, ?, ?)").run("b", "b", "B", "x", "public", 1);
    before.sqlite.prepare("INSERT INTO servers (id, slug, name, template_id, access, created_at) VALUES (?, ?, ?, ?, ?, ?)").run("c", "c", "C", "x", "private", 1);
    before.sqlite.close();

    const after = openDb(file);
    const rows = after.sqlite.prepare("SELECT id, access, hide_ip AS hideIp FROM servers ORDER BY id").all();
    after.sqlite.close();
    expect(rows).toEqual([
      { id: "a", access: "private", hideIp: 1 },
      { id: "b", access: "public", hideIp: 0 },
      { id: "c", access: "private", hideIp: 0 },
    ]);
  });
});
