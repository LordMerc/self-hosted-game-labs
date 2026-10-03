import { beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/server/config.js";
import { openDb, schema } from "../src/server/db/index.js";
import { buildPayload, describe as words, Notifier, parseWebhook, WebhookError, type NotifyEvent, type NotifyKind, type NotifySink } from "../src/server/notifications/notifier.js";
import { ServerService } from "../src/server/servers/service.js";
import { loadTemplates } from "../src/server/templates/loader.js";
import { FakeConnectivity, FakeDocker } from "./helpers/fakes.js";

const config = loadConfig({ SESSION_SECRET: "s".repeat(40), DATA_DIR: "/tmp/x" });
const DISCORD = "https://discord.com/api/webhooks/123456/secret-token";

interface Call {
  url: string;
  body: Record<string, unknown>;
}

function fakeFetch(replies: { status?: number; body?: unknown }[] = []) {
  const calls: Call[] = [];
  const fn = (async (url: string, init: { body: string }) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    const r = replies.shift() ?? { status: 204 };
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status ?? 204 });
  }) as unknown as typeof fetch;
  return { calls, fn };
}

describe("parseWebhook", () => {
  it("picks the Discord format from the address, and generic for anything else", () => {
    expect(parseWebhook(DISCORD)).toMatchObject({ kind: "discord", host: "discord.com" });
    expect(parseWebhook("https://discordapp.com/api/webhooks/1/x").kind).toBe("discord");
    expect(parseWebhook("https://ptb.discord.com/api/webhooks/1/x").kind).toBe("discord");
    expect(parseWebhook("http://192.168.1.5:5678/webhook/games")).toMatchObject({ kind: "generic", host: "192.168.1.5" });
    expect(parseWebhook("https://discord.com/channels/1/2").kind).toBe("generic");
  });

  it("rejects text that is not a web address", () => {
    expect(() => parseWebhook("not a url")).toThrow(WebhookError);
    expect(() => parseWebhook("ftp://example.com/hook")).toThrow(/https/);
  });
});

describe("messages", () => {
  const at = new Date("2026-10-03T12:00:00Z");

  it("builds a Discord embed that cannot ping anyone", () => {
    const p = buildPayload("discord", { kind: "down", server: "@everyone Palworld" }, "gamelabs", at) as { allowed_mentions: unknown; embeds: { title: string; color: number }[] };
    expect(p.allowed_mentions).toEqual({ parse: [] });
    expect(p.embeds[0].title).toBe("@everyone Palworld went down");
    expect(p.embeds[0].color).toBe(0xf85149);
  });

  it("builds a plain payload with content, text and fields for other services", () => {
    const p = buildPayload("generic", { kind: "online", server: "Palworld" }, "gamelabs", at);
    expect(p).toMatchObject({ content: "Palworld is online. Players can join.", text: "Palworld is online. Players can join.", event: "online", server: "Palworld", at: at.toISOString() });
  });

  it("marks messages from a non-default panel so a beta panel is not mistaken for the real one", () => {
    expect((buildPayload("generic", { kind: "online", server: "Palworld" }, "beta", at) as { title: string }).title).toBe("[beta] Palworld is online");
  });

  it("words each event, including joins, leaves and a server that never started", () => {
    const join: NotifyEvent = { kind: "playerJoin", server: "Palworld", players: { online: 3, max: 32, change: 2 } };
    expect(words(join)).toMatchObject({ title: "Palworld: 2 players joined", text: "3 of 32 players online" });
    expect(words({ kind: "playerLeave", server: "Palworld", players: { online: 0, max: 0, change: -1 } })).toMatchObject({ title: "Palworld: 1 player left", text: "0 players online" });
    expect(words({ kind: "down", server: "Palworld", failedToStart: true, detail: "Deploy failed: x" }).title).toBe("Palworld failed to start");
    expect(words({ kind: "backupFailed", server: "Palworld", detail: "disk full" })).toMatchObject({ title: "Palworld: backup failed", text: "disk full" });
  });
});

describe("Notifier", () => {
  it("starts unconfigured and sends nothing", async () => {
    const f = fakeFetch();
    const n = new Notifier(openDb(":memory:").db, config, f.fn);
    expect(n.status()).toMatchObject({ configured: false, kind: null, host: null });
    n.notify({ kind: "online", server: "A" });
    await n.idle();
    expect(f.calls).toEqual([]);
  });

  it("stores the address encrypted and never reports it back", () => {
    const { db } = openDb(":memory:");
    const n = new Notifier(db, config, fakeFetch().fn);
    n.save({ url: DISCORD });
    const stored = db.select().from(schema.settings).all().find((r) => r.key === "notify_url")!.value;
    expect(stored).not.toContain("secret-token");
    expect(JSON.stringify(n.status())).not.toContain("secret-token");
    expect(n.status()).toMatchObject({ configured: true, kind: "discord", host: "discord.com" });
  });

  it("keeps the saved address when only the toggles change, and needs one the first time", () => {
    const n = new Notifier(openDb(":memory:").db, config, fakeFetch().fn);
    expect(() => n.save({ events: { online: false } })).toThrow(/Paste a webhook/);
    n.save({ url: DISCORD });
    n.save({ url: "", events: { online: false } });
    expect(n.status()).toMatchObject({ configured: true, events: { online: false, down: true, playerJoin: true, playerLeave: false, backupFailed: true } });
  });

  it("only sends the events that are switched on", async () => {
    const f = fakeFetch();
    const n = new Notifier(openDb(":memory:").db, config, f.fn);
    n.save({ url: DISCORD, events: { online: false } });
    expect(n.wants("online")).toBe(false);
    expect(n.wants("playerLeave")).toBe(false);
    n.notify({ kind: "online", server: "A" });
    n.notify({ kind: "down", server: "A" });
    n.notify({ kind: "playerLeave", server: "A", players: { online: 0, max: 8, change: -1 } });
    await n.idle();
    expect(f.calls.map((c) => (c.body.embeds as { title: string }[])[0].title)).toEqual(["A went down"]);
    expect(f.calls[0].url).toBe(DISCORD);
  });

  it("sends in order and records the last send", async () => {
    const f = fakeFetch();
    const n = new Notifier(openDb(":memory:").db, config, f.fn);
    n.save({ url: "https://example.com/hook" });
    n.notify({ kind: "online", server: "A" });
    n.notify({ kind: "down", server: "B" });
    await n.idle();
    expect(f.calls.map((c) => c.body.server)).toEqual(["A", "B"]);
    expect(n.status().lastSentAt).not.toBeNull();
    expect(n.status().lastError).toBeNull();
  });

  it("remembers a failure without throwing, and without repeating the secret address", async () => {
    const n = new Notifier(openDb(":memory:").db, config, fakeFetch([{ status: 404, body: { message: "Unknown Webhook" } }]).fn);
    n.save({ url: DISCORD });
    n.notify({ kind: "online", server: "A" });
    await n.idle();
    expect(n.status().lastError).toBe("The webhook answered 404: Unknown Webhook");
  });

  it("reports a network failure as a short message", async () => {
    const failing = (async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
    }) as unknown as typeof fetch;
    const n = new Notifier(openDb(":memory:").db, config, failing);
    await expect(n.sendTest(DISCORD)).rejects.toThrow("Could not reach the webhook (ENOTFOUND)");
  });

  it("waits and retries once when Discord says slow down", async () => {
    const f = fakeFetch([{ status: 429, body: { retry_after: 0.01 } }, { status: 204 }]);
    const n = new Notifier(openDb(":memory:").db, config, f.fn);
    await n.sendTest(DISCORD);
    expect(f.calls).toHaveLength(2);
  });

  it("tests an address before it is saved, and the saved one otherwise", async () => {
    const f = fakeFetch();
    const n = new Notifier(openDb(":memory:").db, config, f.fn);
    await expect(n.sendTest()).rejects.toThrow(/Paste a webhook/);
    await n.sendTest("https://example.com/new");
    expect(f.calls[0].url).toBe("https://example.com/new");
    expect(n.status().configured).toBe(false);
    n.save({ url: DISCORD });
    await n.sendTest();
    expect(f.calls[1].url).toBe(DISCORD);
    expect((f.calls[1].body.embeds as { title: string }[])[0].title).toMatch(/Test message/);
  });

  it("clear forgets the address and the toggles", () => {
    const n = new Notifier(openDb(":memory:").db, config, fakeFetch().fn);
    n.save({ url: DISCORD, events: { online: false } });
    n.clear();
    expect(n.status()).toMatchObject({ configured: false });
    expect(n.status().events.online).toBe(true);
  });
});

class Recorder implements NotifySink {
  sent: NotifyEvent[] = [];
  off = new Set<NotifyKind>();
  wants = (k: NotifyKind) => !this.off.has(k);
  notify = (e: NotifyEvent) => void this.sent.push(e);
  kinds = () => this.sent.map((e) => `${e.kind}:${e.server}`);
}

describe("server events", () => {
  let docker: FakeDocker;
  let svc: ServerService;
  let rec: Recorder;
  let dir: string;
  let players: { online: number; max: number } | null;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "gl-notify-"));
    docker = new FakeDocker();
    rec = new Recorder();
    players = { online: 0, max: 32 };
    svc = new ServerService({
      config: loadConfig({ SESSION_SECRET: "x".repeat(32), DATA_DIR: dir, GAMESERVERS_DIR: path.join(dir, "games") }),
      db: openDb(":memory:").db,
      templates: loadTemplates(path.resolve("templates")),
      docker,
      connectivity: new FakeConnectivity(),
      hostPorts: () => new Set(),
      background: false,
      stableMs: 0,
      queryPlayers: async () => players,
      notifier: rec,
    });
  });

  const deploy = (name = "Palworld") => svc.deploy({ templateId: "palworld", name });
  const containerOf = (id: string) => svc.getRow(id).containerId!;

  it("reports a finished deploy as online, once", async () => {
    await deploy();
    expect(rec.kinds()).toEqual(["online:Palworld"]);
  });

  it("reports a deploy that never came up as failed to start", async () => {
    docker.crashOnStart = true;
    await deploy();
    expect(rec.sent).toHaveLength(1);
    expect(rec.sent[0]).toMatchObject({ kind: "down", server: "Palworld", failedToStart: true });
    expect(rec.sent[0].detail).toMatch(/Container stopped during startup/);
  });

  it("says nothing when the panel itself stops, starts or restarts a server except the start coming up", async () => {
    const id = await deploy();
    rec.sent.length = 0;
    await svc.stop(id);
    await svc.restart(id);
    expect(rec.sent).toEqual([]);
    await svc.stop(id);
    await svc.start(id);
    expect(rec.kinds()).toEqual(["online:Palworld"]);
  });

  it("does not call a stop in progress a crash when a status refresh lands in the middle", async () => {
    const id = await deploy();
    rec.sent.length = 0;
    const realStop = docker.stop.bind(docker);
    docker.stop = async (c) => {
      await realStop(c);
      await svc.refreshStatuses(); // container has exited, the panel has not yet recorded the stop
    };
    await svc.stop(id);
    expect(rec.sent).toEqual([]);
  });

  it("reports a container that stopped on its own, once, and again when it comes back", async () => {
    const id = await deploy();
    rec.sent.length = 0;
    docker.containers.get(containerOf(id))!.state = "exited";
    await svc.refreshStatuses();
    await svc.refreshStatuses();
    expect(rec.kinds()).toEqual(["down:Palworld"]);
    expect(rec.sent[0].failedToStart).toBe(false);
    docker.containers.get(containerOf(id))!.state = "running";
    await svc.refreshStatuses();
    expect(rec.kinds()).toEqual(["down:Palworld", "online:Palworld"]);
  });

  it("reports a container Docker restarted after a crash, even though it never looked stopped", async () => {
    const id = await deploy();
    await svc.refreshStatuses(); // learns when it started
    rec.sent.length = 0;
    docker.starts.set(containerOf(id), 5); // a new start time
    await svc.refreshStatuses();
    await svc.refreshStatuses();
    expect(rec.kinds()).toEqual(["down:Palworld"]);
    expect(rec.sent[0].detail).toMatch(/started it again/);
  });

  it("does not report a restart the panel did", async () => {
    const id = await deploy();
    await svc.refreshStatuses();
    rec.sent.length = 0;
    await svc.restart(id);
    await svc.refreshStatuses();
    expect(rec.sent).toEqual([]);
  });

  it("reports joins and leaves from the player count, and treats the first reading as a baseline", async () => {
    await deploy();
    rec.sent.length = 0;
    players = { online: 2, max: 32 };
    await svc.pollPlayers();
    expect(rec.sent).toEqual([]); // two were already there
    players = { online: 3, max: 32 };
    await svc.pollPlayers();
    players = { online: 3, max: 32 };
    await svc.pollPlayers();
    players = { online: 1, max: 32 };
    await svc.pollPlayers();
    expect(rec.sent).toEqual([
      { kind: "playerJoin", server: "Palworld", players: { online: 3, max: 32, change: 1 } },
      { kind: "playerLeave", server: "Palworld", players: { online: 1, max: 32, change: -2 } },
    ]);
  });

  it("starts over after the game stops answering, so a restart does not look like everyone joining", async () => {
    await deploy();
    players = { online: 2, max: 32 };
    await svc.pollPlayers();
    players = null;
    await svc.pollPlayers();
    players = { online: 2, max: 32 };
    await svc.pollPlayers();
    expect(rec.sent.filter((e) => e.kind.startsWith("player"))).toEqual([]);
  });

  it("does not ask the game for players when both player events are off", async () => {
    await deploy();
    let asked = 0;
    players = { online: 1, max: 8 };
    (svc as unknown as { d: { queryPlayers: unknown } }).d.queryPlayers = async () => (asked++, players);
    rec.off = new Set<NotifyKind>(["playerJoin", "playerLeave"]);
    await svc.pollPlayers();
    expect(asked).toBe(0);
  });

  it("reports a failed backup", async () => {
    const id = await deploy();
    mkdirSync(path.join(dir, "games", "palworld"), { recursive: true });
    writeFileSync(path.join(dir, "games", ".backups"), "in the way"); // the backup folder cannot be made
    rec.sent.length = 0;
    await expect(svc.backup(id)).rejects.toThrow();
    expect(rec.sent).toHaveLength(1);
    expect(rec.sent[0]).toMatchObject({ kind: "backupFailed", server: "Palworld" });
  });

  it("keeps working when the notifier throws", async () => {
    rec.notify = () => {
      throw new Error("boom");
    };
    const id = await deploy();
    await svc.stop(id);
    expect((await svc.list())[0].status).toBe("offline");
  });
});
