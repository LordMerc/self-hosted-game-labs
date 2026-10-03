import { beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/server/app.js";
import { loadConfig } from "../src/server/config.js";
import { openDb } from "../src/server/db/index.js";
import { loadTemplates } from "../src/server/templates/loader.js";
import { ServerService } from "../src/server/servers/service.js";
import { FakeConnectivity, FakeDocker } from "./helpers/fakes.js";
import { DnsSettings } from "../src/server/dns/settings.js";
import { Notifier } from "../src/server/notifications/notifier.js";

// Deploys create the server's folder, so it must be somewhere the test can write (the default, /srv/gameservers, is not on CI).
const games = mkdtempSync(path.join(os.tmpdir(), "gl-api-")).replace(/^[A-Za-z]:/, "").replaceAll("\\", "/");
const config = loadConfig({ SESSION_SECRET: "x".repeat(32), DATA_DIR: "/tmp/unused", GAMESERVERS_DIR: games });
let app: FastifyInstance;
let fakeDocker: FakeDocker;

beforeEach(() => {
  const { db } = openDb(":memory:");
  const templates = loadTemplates(path.resolve("templates"));
  const docker = (fakeDocker = new FakeDocker());
  const service = new ServerService({ config, db, templates, docker, connectivity: new FakeConnectivity(), hostPorts: () => new Set(), background: false, stableMs: 0 });
  app = buildApp({ config, db, templates, service, docker, dnsSettings: new DnsSettings(db, config), notifier: new Notifier(db, config) });
});

const cookieOf = (res: { headers: Record<string, unknown> }) => String(([] as string[]).concat(res.headers["set-cookie"] as string)[0]).split(";")[0];

describe("api", () => {
  it("serves /api/health without auth", async () => {
    const res = await app.inject("/api/health");
    expect(res.json()).toMatchObject({ status: "ok" });
  });

  it("lists another panel's servers read-only, behind the login, and offers no way to act on them", async () => {
    fakeDocker.others = [{ name: "gl-palworld", instance: "gamelabs", slug: "palworld", image: "x/palworld", state: "running", ports: [{ port: 8211, protocol: "udp" }] }];
    expect((await app.inject("/api/other-panels")).statusCode).toBe(401);
    const setup = await app.inject({ method: "POST", url: "/api/auth/setup", payload: { password: "correct horse battery" } });
    const res = await app.inject({ url: "/api/other-panels", headers: { cookie: cookieOf(setup) } });
    expect(res.json()).toEqual(fakeDocker.others);
    const del = await app.inject({ method: "DELETE", url: "/api/other-panels/gl-palworld", headers: { cookie: cookieOf(setup) } });
    expect(del.statusCode).toBe(404);
    expect(fakeDocker.containers.size).toBe(0);
  });

  it("requires a session for everything else", async () => {
    expect((await app.inject("/api/servers")).statusCode).toBe(401);
    expect((await app.inject("/api/templates")).statusCode).toBe(401);
  });

  it("first run: setup creates the password and signs in; setup cannot run twice", async () => {
    expect((await app.inject("/api/auth/status")).json().setupRequired).toBe(true);
    const setup = await app.inject({ method: "POST", url: "/api/auth/setup", payload: { password: "correct horse battery" } });
    expect(setup.statusCode).toBe(200);
    const authed = await app.inject({ url: "/api/servers", headers: { cookie: cookieOf(setup) } });
    expect(authed.statusCode).toBe(200);
    const again = await app.inject({ method: "POST", url: "/api/auth/setup", payload: { password: "another long password" } });
    expect(again.statusCode).toBe(409);
  });

  it("rejects short passwords and wrong logins, accepts the right one", async () => {
    expect((await app.inject({ method: "POST", url: "/api/auth/setup", payload: { password: "short" } })).statusCode).toBe(400);
    await app.inject({ method: "POST", url: "/api/auth/setup", payload: { password: "correct horse battery" } });
    expect((await app.inject({ method: "POST", url: "/api/auth/login", payload: { password: "nope" } })).statusCode).toBe(401);
    const ok = await app.inject({ method: "POST", url: "/api/auth/login", payload: { password: "correct horse battery" } });
    expect(ok.statusCode).toBe(200);
  });

  it("rate-limits repeated bad logins", async () => {
    await app.inject({ method: "POST", url: "/api/auth/setup", payload: { password: "correct horse battery" } });
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) codes.push((await app.inject({ method: "POST", url: "/api/auth/login", payload: { password: "bad" } })).statusCode);
    expect(codes.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(codes.slice(5)).toEqual([429, 429]);
  });

  it("rejects a forged session cookie", async () => {
    const res = await app.inject({ url: "/api/servers", headers: { cookie: `gl_session=${Date.now() + 100000}` } });
    expect(res.statusCode).toBe(401);
  });

  it("deploys through the API and reports a port conflict as 409 with a suggestion", async () => {
    const setup = await app.inject({ method: "POST", url: "/api/auth/setup", payload: { password: "correct horse battery" } });
    const headers = { cookie: cookieOf(setup) };
    const first = await app.inject({ method: "POST", url: "/api/servers", headers, payload: { templateId: "palworld", name: "One" } });
    expect(first.statusCode).toBe(202);
    const list = (await app.inject({ url: "/api/servers", headers })).json();
    expect(list).toHaveLength(1);
    expect(list[0]).not.toHaveProperty("env");
    const clash = await app.inject({ method: "POST", url: "/api/servers", headers, payload: { templateId: "palworld", name: "Two", ports: { game: 8211, query: 27050 } } });
    expect(clash.statusCode).toBe(409);
    expect(clash.json().suggestion).toBeTruthy();
    expect((await app.inject({ method: "POST", url: "/api/servers", headers, payload: { templateId: "nope", name: "x" } })).statusCode).toBe(404);
  });

  it("DNS settings API: check lists zones, save validates, env-managed DNS is read-only", async () => {
    const setup = await app.inject({ method: "POST", url: "/api/auth/setup", payload: { password: "correct horse battery" } });
    const headers = { cookie: cookieOf(setup) };
    expect((await app.inject({ url: "/api/settings/dns", headers })).json()).toMatchObject({ configured: false });
    expect((await app.inject({ url: "/api/settings/dns", headers: {} })).statusCode).toBe(401);
    const empty = await app.inject({ method: "POST", url: "/api/settings/dns/check", headers, payload: {} });
    expect(empty.statusCode).toBe(400);
    const bad = await app.inject({ method: "PUT", url: "/api/settings/dns", headers, payload: { zone: "example.com", host: "play.other.org" } });
    expect(bad.statusCode).toBe(400);
  });
});

describe("backups tab", () => {
  it("requires a session, lists backups, and redeploys a deleted server from one", async () => {
    expect((await app.inject("/api/backups")).statusCode).toBe(401);
    const setup = await app.inject({ method: "POST", url: "/api/auth/setup", payload: { password: "correct horse battery" } });
    const headers = { cookie: cookieOf(setup) };
    expect((await app.inject({ url: "/api/backups", headers })).json()).toEqual([]);
    const bad = await app.inject({ method: "POST", url: "/api/backups/nothing/x-20200101-000000.tar.gz/redeploy", headers, payload: {} });
    expect(bad.statusCode).toBe(404);
    const del = await app.inject({ method: "DELETE", url: "/api/backups/nothing/x-20200101-000000.tar.gz", headers });
    expect(del.statusCode).toBe(404);
  });
});

describe("stats", () => {
  it("requires a session and returns host figures and per-server usage", async () => {
    expect((await app.inject("/api/stats")).statusCode).toBe(401);
    const setup = await app.inject({ method: "POST", url: "/api/auth/setup", payload: { password: "correct horse battery" } });
    const res = await app.inject({ url: "/api/stats", headers: { cookie: cookieOf(setup) } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ host: { cpu: { cores: expect.any(Number) } }, servers: {}, history: { intervalSec: 20, host: { cpu: [] } }, docker: { name: "homelab-01" } });
  });

  it("lists recent activity across servers, without console and schedule chatter", async () => {
    const setup = await app.inject({ method: "POST", url: "/api/auth/setup", payload: { password: "correct horse battery" } });
    const headers = { cookie: cookieOf(setup) };
    expect((await app.inject("/api/activity")).statusCode).toBe(401);
    const made = await app.inject({ method: "POST", url: "/api/servers", headers, payload: { templateId: "valheim", name: "Vikings", env: { SERVER_PASS: "abcdef" } } });
    expect(made.statusCode).toBeLessThan(300);
    const res = await app.inject({ url: "/api/activity", headers });
    const items = res.json() as { server: string | null; message: string }[];
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => !/^Deploy started|^Pulling /.test(i.message))).toBe(true);
    expect(items[0]).toMatchObject({ server: "Vikings", message: "Server is online" });
  });

  it("offers a template's artwork only when the file is there, and never outside the templates folder", async () => {
    const setup = await app.inject({ method: "POST", url: "/api/auth/setup", payload: { password: "correct horse battery" } });
    const headers = { cookie: cookieOf(setup) };
    const list = (await app.inject({ url: "/api/templates", headers })).json() as { id: string; accent: string | null; artwork: string | null }[];
    expect(list.find((t) => t.id === "palworld")).toMatchObject({ accent: "#4ade80", artwork: null });
    // The panel can read a player count for these games and cannot for the rest, which the page says instead of showing a blank.
    expect(Object.fromEntries(list.map((t) => [t.id, t.reportsPlayers]))).toMatchObject({ palworld: true, minecraft: true, valheim: true, dragonwilds: false, satisfactory: false, terraria: false });
    expect((await app.inject({ url: "/api/templates/palworld/artwork", headers })).statusCode).toBe(404);
  });
});

describe("server page routes", () => {
  it("require a session, 404 for unknown servers, and validate bodies", async () => {
    expect((await app.inject("/api/servers/nope")).statusCode).toBe(401);
    const setup = await app.inject({ method: "POST", url: "/api/auth/setup", payload: { password: "correct horse battery" } });
    const headers = { cookie: cookieOf(setup) };
    expect((await app.inject({ url: "/api/servers/nope", headers })).statusCode).toBe(404);
    expect((await app.inject({ method: "PUT", url: "/api/servers/nope/settings", headers, payload: { name: "x" } })).statusCode).toBe(404);
    expect((await app.inject({ method: "PUT", url: "/api/servers/nope/settings", headers, payload: { name: 5 } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/servers/nope/console", headers, payload: {} })).statusCode).toBe(400);
  });

  it("takes resource limits on deploy and on the settings route, and lists the template's memory minimum", async () => {
    const setup = await app.inject({ method: "POST", url: "/api/auth/setup", payload: { password: "correct horse battery" } });
    const headers = { cookie: cookieOf(setup) };
    const catalog = (await app.inject({ url: "/api/templates", headers })).json() as { id: string; minMemoryMb: number | null }[];
    expect(catalog.find((t) => t.id === "satisfactory")!.minMemoryMb).toBe(8192);
    expect(catalog.find((t) => t.id === "terraria")!.minMemoryMb).toBeNull();
    const made = await app.inject({ method: "POST", url: "/api/servers", headers, payload: { templateId: "terraria", name: "Terra", cpus: 1, memoryMb: 1024 } });
    expect(made.statusCode).toBe(202);
    const id = made.json().id as string;
    expect((await app.inject({ url: `/api/servers/${id}`, headers })).json().server.limits).toMatchObject({ cpus: 1, memoryMb: 1024 });
    const bad = await app.inject({ method: "PUT", url: `/api/servers/${id}/settings`, headers, payload: { memoryMb: 10 } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ field: "memoryMb" });
    const cleared = await app.inject({ method: "PUT", url: `/api/servers/${id}/settings`, headers, payload: { cpus: null, memoryMb: null } });
    expect(cleared.statusCode).toBe(202);
    expect((await app.inject({ url: `/api/servers/${id}`, headers })).json().server.limits).toMatchObject({ cpus: null, memoryMb: null });
  });

  it("sets up a server from a custom image, keeps it out of the template catalog, and explains bad input", async () => {
    const setup = await app.inject({ method: "POST", url: "/api/auth/setup", payload: { password: "correct horse battery" } });
    const headers = { cookie: cookieOf(setup) };
    const ok = await app.inject({ method: "POST", url: "/api/servers/custom", headers, payload: { name: "Mine", image: "x/y:1", ports: [{ port: 3000, protocol: "tcp" }], env: { A: "b" } } });
    expect(ok.statusCode).toBe(202);
    const list = (await app.inject({ url: "/api/servers", headers })).json();
    expect(list[0]).toMatchObject({ name: "Mine", templateName: "Custom image", status: "online" });
    const catalog = (await app.inject({ url: "/api/templates", headers })).json() as { id: string }[];
    expect(catalog.some((t) => t.id.startsWith("custom-"))).toBe(false);
    expect(catalog.map((t) => t.id)).toEqual(expect.arrayContaining(["minecraft", "valheim", "satisfactory", "terraria"]));
    const bad = await app.inject({ method: "POST", url: "/api/servers/custom", headers, payload: { name: "Mine 2", image: "no good", ports: [{ port: 3001, protocol: "tcp" }] } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatch(/Docker image name/);
    expect((await app.inject({ method: "POST", url: "/api/servers/custom", headers, payload: { name: "x" } })).statusCode).toBe(400);
  });
});

describe("notification settings", () => {
  it("need a session, save an address without ever returning it, and explain bad input", async () => {
    expect((await app.inject("/api/settings/notifications")).statusCode).toBe(401);
    const setup = await app.inject({ method: "POST", url: "/api/auth/setup", payload: { password: "correct horse battery" } });
    const headers = { cookie: cookieOf(setup) };
    expect((await app.inject({ url: "/api/settings/notifications", headers })).json()).toMatchObject({ configured: false });

    const none = await app.inject({ method: "PUT", url: "/api/settings/notifications", headers, payload: { events: { online: false } } });
    expect(none.statusCode).toBe(400);
    const bad = await app.inject({ method: "PUT", url: "/api/settings/notifications", headers, payload: { url: "nope" } });
    expect(bad.statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/settings/notifications/test", headers, payload: { url: "nope" } })).statusCode).toBe(400);

    const url = "https://discord.com/api/webhooks/1/very-secret";
    const saved = await app.inject({ method: "PUT", url: "/api/settings/notifications", headers, payload: { url, events: { playerLeave: true } } });
    expect(saved.statusCode).toBe(200);
    expect(saved.body).not.toContain("very-secret");
    expect(saved.json()).toMatchObject({ configured: true, kind: "discord", events: { online: true, playerLeave: true } });

    expect((await app.inject({ method: "DELETE", url: "/api/settings/notifications", headers })).statusCode).toBe(200);
    expect((await app.inject({ url: "/api/settings/notifications", headers })).json()).toMatchObject({ configured: false });
  });
});
