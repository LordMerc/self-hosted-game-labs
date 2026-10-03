import { describe, expect, it } from "vitest";
import { CheckHostProbe, interpret } from "../src/server/reachability.js";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A fake check-host.net: answers the start request, then each poll with the next canned reply. */
function fakeService(start: unknown, polls: unknown[], opts: { startStatus?: number } = {}) {
  const urls: string[] = [];
  let n = 0;
  const fetchFn = (async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    if (url.includes("/check-tcp")) return json(start, opts.startStatus ?? 200);
    const reply = polls[Math.min(n++, polls.length - 1)];
    return json(reply);
  }) as typeof fetch;
  return { fetchFn, urls };
}

const probe = (f: typeof fetch) => new CheckHostProbe(f, "https://ch.test", { pollMs: 1, timeoutMs: 500 });
const started = { ok: 1, request_id: "abc123", nodes: { "de1.node": [], "us1.node": [], "jp1.node": [] } };

describe("interpret", () => {
  it("is open when any location connected", () => {
    const r = interpret({ a: [{ time: 0.04, address: "1.2.3.4" }], b: [{ error: "Connection timed out" }], c: [{ time: 0.1, address: "1.2.3.4" }] }, "x");
    expect(r).toEqual({ state: "open", detail: "Connected from 2 of 3 locations" });
  });

  it("is closed, with the reasons, when every location failed", () => {
    const r = interpret({ a: [{ error: "Connection timed out" }], b: [{ error: "Connection refused" }] }, "x");
    expect(r.state).toBe("closed");
    expect(r.detail).toBe("Could not connect from any of 2 locations (Connection timed out, Connection refused)");
  });

  it("does not guess from locations that never answered, or from replies it does not understand", () => {
    expect(interpret({ a: null, b: null }, "check-host.net")).toEqual({ state: "unknown", detail: "check-host.net gave no answer in time" });
    expect(interpret({ a: [{ weird: true }], b: "nope" }, "x").state).toBe("unknown");
    expect(interpret({ a: null, b: [{ error: "Connection refused" }] }, "x").state).toBe("closed"); // one answer, and it was no
  });

  it("copes with a reply nested one level deeper", () => {
    expect(interpret({ a: [[{ time: 0.2, address: "1.2.3.4" }]] }, "x").state).toBe("open");
  });
});

describe("CheckHostProbe", () => {
  it("starts a TCP check on the right host and port, waits for every location, and reports", async () => {
    const pending = { "de1.node": null, "us1.node": [{ time: 0.03, address: "203.0.113.7" }], "jp1.node": null };
    const done = { "de1.node": [{ time: 0.05, address: "203.0.113.7" }], "us1.node": [{ time: 0.03, address: "203.0.113.7" }], "jp1.node": [{ error: "Connection timed out" }] };
    const { fetchFn, urls } = fakeService(started, [pending, done]);
    const r = await probe(fetchFn).check("203.0.113.7", 25565);
    expect(r).toEqual({ state: "open", detail: "Connected from 2 of 3 locations" });
    expect(urls[0]).toBe("https://ch.test/check-tcp?host=203.0.113.7%3A25565&max_nodes=3");
    expect(urls[1]).toBe("https://ch.test/check-result/abc123");
    expect(urls.length).toBe(3);
  });

  it("says closed when nobody could connect", async () => {
    const { fetchFn } = fakeService(started, [{ a: [{ error: "Connection refused" }], b: [{ error: "Connection refused" }] }]);
    expect((await probe(fetchFn).check("1.2.3.4", 7777)).state).toBe("closed");
  });

  it("is unknown, never open or closed, when the service is rate limited, down, or answers oddly", async () => {
    const limited = await probe(fakeService({ ok: 0, error: "limit_exceeded" }, []).fetchFn).check("1.2.3.4", 1);
    expect(limited.state).toBe("unknown");
    expect(limited.detail).toMatch(/limit_exceeded/);
    const down = await probe(fakeService({}, [], { startStatus: 503 }).fetchFn).check("1.2.3.4", 1);
    expect(down).toMatchObject({ state: "unknown" });
    expect(down.detail).toMatch(/HTTP 503/);
    const dead = await probe((async () => Promise.reject(new Error("getaddrinfo ENOTFOUND"))) as typeof fetch).check("1.2.3.4", 1);
    expect(dead.detail).toMatch(/ENOTFOUND/);
    const odd = await probe(fakeService("<html>", []).fetchFn).check("1.2.3.4", 1);
    expect(odd.state).toBe("unknown");
  });

  it("uses what has arrived when some locations stay silent until the time limit", async () => {
    const { fetchFn } = fakeService(started, [{ a: [{ time: 0.1, address: "1.2.3.4" }], b: null, c: null }]);
    expect(await probe(fetchFn).check("1.2.3.4", 1)).toEqual({ state: "open", detail: "Connected from 1 of 1 locations" });
  });
});
