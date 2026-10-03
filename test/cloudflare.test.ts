import { describe, expect, it } from "vitest";
import { CloudflareClient, DnsError } from "../src/server/dns/cloudflare.js";

interface Rec { id: string; type: string; name: string; content: string; proxied: boolean; comment: string | null }

/** Minimal in-memory Cloudflare: zones lookup + dns_records CRUD. */
function fakeCloudflare(initial: Rec[] = []) {
  const records = [...initial];
  const calls: { method: string; url: string; body?: any; auth?: string }[] = [];
  const fetchFn = (async (url: string, init: any) => {
    const u = new URL(url);
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method: init.method, url: u.pathname + u.search, body, auth: init.headers.authorization });
    const ok = (result: unknown) => new Response(JSON.stringify({ success: true, result }), { status: 200 });
    if (u.pathname === "/client/v4/zones") return ok([{ id: "z".repeat(32) }]);
    const m = u.pathname.match(/dns_records(?:\/(\w+))?$/);
    if (init.method === "GET") return ok(records.filter((r) => r.type === u.searchParams.get("type") && r.name === u.searchParams.get("name")));
    if (init.method === "POST") { records.push({ id: `r${records.length + 1}`, ...body }); return ok(body); }
    if (init.method === "PUT") { Object.assign(records.find((r) => r.id === m![1])!, body); return ok(body); }
    if (init.method === "DELETE") { records.splice(records.findIndex((r) => r.id === m![1]), 1); return ok({}); }
    throw new Error("unexpected " + init.method);
  }) as unknown as typeof fetch;
  return { records, calls, client: new CloudflareClient("secret-token", "example.com", fetchFn) };
}

describe("CloudflareClient", () => {
  it("creates DNS-only records tagged with the gamelabs comment", async () => {
    const { client, records } = fakeCloudflare();
    expect(await client.upsertCname("palworld", "play.example.com")).toBe("created");
    expect(records[0]).toMatchObject({ type: "CNAME", name: "palworld.example.com", content: "play.example.com", proxied: false, comment: "gamelabs:palworld" });
  });

  it("DDNS A record is unchanged when the IP is the same and updated when it changes", async () => {
    const { client, records } = fakeCloudflare();
    expect(await client.upsertA("play.example.com", "1.1.1.1")).toBe("created");
    expect(records[0].comment).toBe("gamelabs:ddns");
    expect(await client.upsertA("play.example.com", "1.1.1.1")).toBe("unchanged");
    expect(await client.upsertA("play.example.com", "2.2.2.2")).toBe("updated");
    expect(records[0].content).toBe("2.2.2.2");
  });

  it("refuses to modify or delete a record it did not create", async () => {
    const mine = { id: "x", type: "A", name: "play.example.com", content: "9.9.9.9", proxied: false, comment: null };
    const theirs = { id: "y", type: "CNAME", name: "palworld.example.com", content: "other.example.com", proxied: true, comment: "something else" };
    const { client, records } = fakeCloudflare([mine, theirs]);
    await expect(client.upsertA("play.example.com", "1.1.1.1")).rejects.toThrow(DnsError);
    await expect(client.upsertCname("palworld", "play.example.com")).rejects.toThrow(/not created by Game Labs/);
    expect(await client.deleteCname("palworld")).toBe(false);
    expect(records).toHaveLength(2);
    expect(records[1].content).toBe("other.example.com");
  });

  it("deletes only its own tagged CNAME", async () => {
    const { client, records } = fakeCloudflare();
    await client.upsertCname("palworld", "play.example.com");
    expect(await client.deleteCname("palworld")).toBe(true);
    expect(records).toHaveLength(0);
  });

  it("never leaks the token into error messages", async () => {
    const fetchFn = (async () => new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }), { status: 403 })) as unknown as typeof fetch;
    const client = new CloudflareClient("secret-token", "example.com", fetchFn);
    const err = await client.upsertA("play.example.com", "1.1.1.1").catch((e) => e as Error);
    expect(err.message).toMatch(/Authentication error/);
    expect(err.message).not.toContain("secret-token");
  });
});
