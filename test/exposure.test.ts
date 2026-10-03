import { describe, expect, it } from "vitest";
import path from "node:path";
import { buildApp } from "../src/server/app.js";
import { loadConfig, parseTrustProxy } from "../src/server/config.js";
import { openDb } from "../src/server/db/index.js";
import { DnsSettings } from "../src/server/dns/settings.js";
import { ServerService } from "../src/server/servers/service.js";
import { loadTemplates } from "../src/server/templates/loader.js";
import { UpdateChecker } from "../src/server/updates.js";
import { FakeConnectivity, FakeDocker } from "./helpers/fakes.js";

const PASSWORD = "correct horse battery";

function make(env: Record<string, string> = {}, fetchFn?: typeof fetch) {
  const config = loadConfig({ SESSION_SECRET: "x".repeat(32), DATA_DIR: "/tmp/unused", APP_VERSION: "0.1.0", ...env });
  const { db } = openDb(":memory:");
  const templates = loadTemplates(path.resolve("templates"));
  const docker = new FakeDocker();
  const service = new ServerService({ config, db, templates, docker, connectivity: new FakeConnectivity(), hostPorts: () => new Set(), background: false, stableMs: 0 });
  const updates = new UpdateChecker(db, { current: config.APP_VERSION, envEnabled: config.UPDATE_CHECK === "on", fetchFn });
  return buildApp({ config, db, templates, service, docker, dnsSettings: new DnsSettings(db, config), updates });
}

type App = ReturnType<typeof make>;
const setup = (app: App, headers: Record<string, string> = {}) => app.inject({ method: "POST", url: "/api/auth/setup", payload: { password: PASSWORD }, headers });
const login = (app: App, password: string, headers: Record<string, string> = {}, remoteAddress?: string) =>
  app.inject({ method: "POST", url: "/api/auth/login", payload: { password }, headers, remoteAddress });
const setCookie = (res: { headers: Record<string, unknown> }) => String(([] as string[]).concat(res.headers["set-cookie"] as string)[0]);

describe("login lockout", () => {
  it("locks a visitor out after repeated wrong passwords, even for the right one, and says how long", async () => {
    const app = make();
    await setup(app);
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await login(app, "bad")).statusCode);
    expect(codes).toEqual([401, 401, 401, 401, 401]);
    const locked = await login(app, PASSWORD);
    expect(locked.statusCode).toBe(429);
    expect(locked.json().error).toMatch(/Try again in 15 minutes/);
    expect(locked.headers["retry-after"]).toBe("900");
  });

  it("does not lock out someone who gets it right in time, and a success starts the count over", async () => {
    const app = make();
    await setup(app);
    for (let i = 0; i < 4; i++) await login(app, "bad");
    expect((await login(app, PASSWORD)).statusCode).toBe(200);
    for (let i = 0; i < 4; i++) expect((await login(app, "bad")).statusCode).toBe(401);
    expect((await login(app, PASSWORD)).statusCode).toBe(200);
  });

  it("tells visitors apart by address, not just by the proxy in front", async () => {
    const app = make({ TRUST_PROXY: "127.0.0.1" });
    await setup(app);
    const from = (ip: string) => ({ "x-forwarded-for": ip });
    for (let i = 0; i < 5; i++) await login(app, "bad", from("198.51.100.7"));
    expect((await login(app, PASSWORD, from("198.51.100.7"))).statusCode).toBe(429);
    expect((await login(app, PASSWORD, from("198.51.100.8"))).statusCode).toBe(200);
  });

  it("ignores X-Forwarded-For unless a proxy is trusted, so it cannot be used to dodge the lockout", async () => {
    const app = make();
    await setup(app);
    for (let i = 0; i < 5; i++) await login(app, "bad", { "x-forwarded-for": `198.51.100.${i}` });
    expect((await login(app, PASSWORD, { "x-forwarded-for": "198.51.100.99" })).statusCode).toBe(429);
  });

  it("pauses all sign-ins when many different visitors keep failing", async () => {
    const app = make({ TRUST_PROXY: "127.0.0.1" });
    await setup(app);
    for (let i = 0; i < 30; i++) await login(app, "bad", { "x-forwarded-for": `203.0.113.${i + 1}` });
    const res = await login(app, PASSWORD, { "x-forwarded-for": "203.0.113.200" });
    expect(res.statusCode).toBe(429);
    expect(res.json().error).toMatch(/paused/);
  });
});

describe("session cookie", () => {
  it("is HttpOnly and SameSite=Strict, and Secure only when the visit came in over HTTPS behind a trusted proxy", async () => {
    const plain = await setup(make());
    expect(setCookie(plain)).toMatch(/HttpOnly/);
    expect(setCookie(plain)).toMatch(/SameSite=Strict/);
    expect(setCookie(plain)).not.toMatch(/Secure/);

    const behindProxy = await setup(make({ TRUST_PROXY: "127.0.0.1" }), { "x-forwarded-proto": "https" });
    expect(setCookie(behindProxy)).toMatch(/; Secure/);

    // A visitor cannot claim HTTPS to a panel that does not trust the sender.
    const spoofed = await setup(make(), { "x-forwarded-proto": "https" });
    expect(setCookie(spoofed)).not.toMatch(/Secure/);
  });

  it("COOKIE_SECURE=always and never override the guess", async () => {
    expect(setCookie(await setup(make({ COOKIE_SECURE: "always" })))).toMatch(/; Secure/);
    expect(setCookie(await setup(make({ COOKIE_SECURE: "never", TRUST_PROXY: "127.0.0.1" }), { "x-forwarded-proto": "https" }))).not.toMatch(/Secure/);
  });
});

describe("response headers", () => {
  it("forbid framing and sniffing, keep API answers out of caches, and send HSTS only over HTTPS", async () => {
    const app = make({ TRUST_PROXY: "127.0.0.1" });
    const http = await app.inject("/api/health");
    expect(http.headers).toMatchObject({ "x-frame-options": "DENY", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "cache-control": "no-store" });
    expect(String(http.headers["content-security-policy"])).toContain("frame-ancestors 'none'");
    expect(http.headers["strict-transport-security"]).toBeUndefined();
    const https = await app.inject({ url: "/api/health", headers: { "x-forwarded-proto": "https" } });
    expect(https.headers["strict-transport-security"]).toMatch(/max-age=\d+/);
  });
});

describe("TRUST_PROXY", () => {
  it("understands off, on and a list, and refuses a bare number", () => {
    expect(parseTrustProxy("")).toBe(false);
    expect(parseTrustProxy("false")).toBe(false);
    expect(parseTrustProxy("true")).toBe(true);
    expect(parseTrustProxy("127.0.0.1, 172.18.0.0/16")).toEqual(["127.0.0.1", "172.18.0.0/16"]);
    expect(() => parseTrustProxy("1")).toThrow(/address of your proxy/);
  });
});

describe("update notice API", () => {
  const release = () => new Response(JSON.stringify({ tag_name: "v0.2.0", name: "v0.2.0", html_url: "https://github.com/LordMerc/self-hosted-game-labs/releases/tag/v0.2.0" }));

  it("needs a sign-in, reports a newer release, and can be switched off from Settings", async () => {
    const app = make({}, (async () => release()) as unknown as typeof fetch);
    expect((await app.inject("/api/updates")).statusCode).toBe(401);
    const cookie = setCookie(await setup(app)).split(";")[0];
    const headers = { cookie };

    expect((await app.inject({ url: "/api/updates", headers })).json()).toMatchObject({ enabled: true, updateAvailable: false, latest: null, current: "0.1.0" });

    const checked = await app.inject({ method: "POST", url: "/api/updates/check", headers });
    expect(checked.json()).toMatchObject({ ran: true, updateAvailable: true, latest: { version: "0.2.0" } });

    const off = await app.inject({ method: "PUT", url: "/api/updates/settings", headers, payload: { enabled: false } });
    expect(off.json()).toMatchObject({ enabled: false, updateAvailable: false });
  });

  it("cannot be switched on from Settings when UPDATE_CHECK=off", async () => {
    const app = make({ UPDATE_CHECK: "off" });
    const headers = { cookie: setCookie(await setup(app)).split(";")[0] };
    const res = await app.inject({ method: "PUT", url: "/api/updates/settings", headers, payload: { enabled: true } });
    expect(res.statusCode).toBe(409);
    expect((await app.inject({ url: "/api/updates", headers })).json()).toMatchObject({ enabled: false, lockedByEnv: true });
  });
});
