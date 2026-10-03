import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/server/config.js";
import { openDb, schema } from "../src/server/db/index.js";
import { CloudflareClient } from "../src/server/dns/cloudflare.js";
import { decrypt, DnsSettings, encrypt } from "../src/server/dns/settings.js";

const cfg = (extra: Record<string, string> = {}) => loadConfig({ SESSION_SECRET: "s".repeat(40), DATA_DIR: "/tmp/x", ...extra });

const fakeClient = (ok = true) =>
  ((token: string, zone: string) => {
    const c = new CloudflareClient(token, zone, (async () => new Response("{}")) as unknown as typeof fetch);
    c.checkZone = async () => {
      if (!ok) throw new Error(`Cloudflare zone "${zone}" not found for this token`);
    };
    return c;
  }) as (t: string, z: string) => CloudflareClient;

describe("token encryption", () => {
  it("round-trips and fails closed with the wrong secret", () => {
    const blob = encrypt("cf-token-123", "secret-a");
    expect(blob).not.toContain("cf-token-123");
    expect(decrypt(blob, "secret-a")).toBe("cf-token-123");
    expect(decrypt(blob, "secret-b")).toBeNull();
  });
});

describe("DnsSettings", () => {
  it("is unconfigured by default", () => {
    const s = new DnsSettings(openDb(":memory:").db, cfg());
    expect(s.status()).toMatchObject({ configured: false, source: null });
    expect(s.current()).toBeUndefined();
  });

  it("saves from the app, stores the token encrypted, and uses it", async () => {
    const { db } = openDb(":memory:");
    const s = new DnsSettings(db, cfg(), fakeClient());
    await s.save({ token: "tok", zone: "Example.com", host: "play.example.com" });
    expect(s.status()).toEqual({ configured: true, source: "app", zone: "example.com", host: "play.example.com", tokenSet: true });
    expect(s.current()?.host).toBe("play.example.com");
    expect(db.select().from(schema.settings).all().find((r) => r.key === "dns_cf_token")!.value).not.toBe("tok");
  });

  it("keeps the saved token when the token field is left blank", async () => {
    const s = new DnsSettings(openDb(":memory:").db, cfg(), fakeClient());
    await s.save({ token: "tok", zone: "example.com", host: "play.example.com" });
    await s.save({ zone: "example.com", host: "games.example.com" });
    expect(s.status().host).toBe("games.example.com");
  });

  it("rejects a hostname outside the zone and a token that cannot see the zone", async () => {
    const good = new DnsSettings(openDb(":memory:").db, cfg(), fakeClient());
    await expect(good.save({ token: "t", zone: "example.com", host: "play.other.org" })).rejects.toThrow(/must be inside example.com/);
    const bad = new DnsSettings(openDb(":memory:").db, cfg(), fakeClient(false));
    await expect(bad.save({ token: "t", zone: "example.com", host: "play.example.com" })).rejects.toThrow(/not found for this token/);
    expect(bad.status().configured).toBe(false);
  });

  it("environment variables override saved settings", async () => {
    const { db } = openDb(":memory:");
    await new DnsSettings(db, cfg(), fakeClient()).save({ token: "t", zone: "saved.com", host: "play.saved.com" });
    const s = new DnsSettings(db, cfg({ CF_API_TOKEN: "envtok", CF_ZONE: "env.com", PUBLIC_HOST: "play.env.com" }), fakeClient());
    expect(s.status()).toMatchObject({ source: "env", zone: "env.com", host: "play.env.com" });
  });

  it("clear removes the saved settings", async () => {
    const s = new DnsSettings(openDb(":memory:").db, cfg(), fakeClient());
    await s.save({ token: "t", zone: "example.com", host: "play.example.com" });
    s.clear();
    expect(s.status().configured).toBe(false);
  });
});

describe("CloudflareClient.inspect", () => {
  const respond = (routes: Record<string, { status?: number; body: unknown }>) =>
    (async (url: string) => {
      const path = new URL(url).pathname.replace("/client/v4", "");
      const r = routes[path] ?? { status: 404, body: { success: false, errors: [{ message: "nope" }] } };
      return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
    }) as unknown as typeof fetch;

  it("lists zones for a good token", async () => {
    const f = respond({ "/user/tokens/verify": { body: { success: true, result: { status: "active" } } }, "/zones": { body: { success: true, result: [{ name: "b.com" }, { name: "a.com" }] } } });
    expect(await CloudflareClient.inspect("t", f)).toEqual({ valid: true, zones: ["a.com", "b.com"], zonesError: null });
  });

  it("reports a missing Zone:Read permission instead of failing", async () => {
    const f = respond({ "/user/tokens/verify": { body: { success: true, result: { status: "active" } } }, "/zones": { status: 403, body: { success: false, errors: [{ message: "Authentication error" }] } } });
    expect(await CloudflareClient.inspect("t", f)).toMatchObject({ valid: true, zones: [], zonesError: "Authentication error" });
  });

  it("rejects an invalid token", async () => {
    const f = respond({ "/user/tokens/verify": { status: 401, body: { success: false, errors: [{ message: "Invalid API Token" }] } } });
    expect(await CloudflareClient.inspect("bad", f)).toEqual({ valid: false, error: "Invalid API Token" });
  });
});
