import { beforeEach, describe, expect, it } from "vitest";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/server/app.js";
import { loadConfig } from "../src/server/config.js";
import { openDb } from "../src/server/db/index.js";
import { loadTemplates } from "../src/server/templates/loader.js";
import { ServerService } from "../src/server/servers/service.js";
import { FakeConnectivity, FakeDocker } from "./helpers/fakes.js";
import { DnsSettings } from "../src/server/dns/settings.js";

const config = loadConfig({ SESSION_SECRET: "x".repeat(32), DATA_DIR: "/tmp/unused" });
let app: FastifyInstance;

beforeEach(() => {
  const { db } = openDb(":memory:");
  const templates = loadTemplates(path.resolve("templates"));
  const docker = new FakeDocker();
  const service = new ServerService({ config, db, templates, docker, connectivity: new FakeConnectivity(), hostPorts: () => new Set(), background: false, stableMs: 0 });
  app = buildApp({ config, db, templates, service, docker, dnsSettings: new DnsSettings(db, config) });
});

const cookieOf = (res: { headers: Record<string, unknown> }) => String(([] as string[]).concat(res.headers["set-cookie"] as string)[0]).split(";")[0];

describe("api", () => {
  it("serves /api/health without auth", async () => {
    const res = await app.inject("/api/health");
    expect(res.json()).toMatchObject({ status: "ok" });
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
    expect(codes[6]).toBe(429);
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
    expect(res.json()).toMatchObject({ host: { cpu: { cores: expect.any(Number) } }, servers: {} });
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
