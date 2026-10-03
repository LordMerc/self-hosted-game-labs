import { describe, expect, it } from "vitest";
import { LoginGuard, visitorKey } from "../src/server/auth/rate-limit.js";

function clock() {
  let t = 1_000_000;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
}
const MIN = 60_000;

describe("LoginGuard", () => {
  it("locks a visitor out after five wrong passwords, then lets them back in", () => {
    const c = clock();
    const g = new LoginGuard({ now: c.now });
    for (let i = 0; i < 4; i++) {
      expect(g.check("a").allowed).toBe(true);
      g.fail("a");
    }
    expect(g.check("a").allowed).toBe(true);
    g.fail("a");
    const locked = g.check("a");
    expect(locked).toMatchObject({ allowed: false, scope: "visitor", retryAfterSec: 15 * 60 });
    expect(g.check("b").allowed).toBe(true); // somebody else is unaffected
    c.advance(15 * MIN + 1);
    expect(g.check("a").allowed).toBe(true);
  });

  it("locks out for longer each time it happens again, up to a ceiling", () => {
    const c = clock();
    const g = new LoginGuard({ now: c.now, maxLockMs: 40 * MIN });
    const lock = () => {
      for (let i = 0; i < 5; i++) g.fail("a");
      const r = g.check("a");
      if (r.allowed) throw new Error("expected a lockout");
      c.advance(r.retryAfterSec * 1000 + 1);
      return r.retryAfterSec / 60;
    };
    expect([lock(), lock(), lock(), lock()]).toEqual([15, 30, 40, 40]);
  });

  it("only counts failures inside the window", () => {
    const c = clock();
    const g = new LoginGuard({ now: c.now });
    for (let i = 0; i < 4; i++) g.fail("a");
    c.advance(16 * MIN);
    g.fail("a");
    expect(g.check("a").allowed).toBe(true);
  });

  it("a correct password clears the record", () => {
    const g = new LoginGuard({ now: clock().now });
    for (let i = 0; i < 4; i++) g.fail("a");
    g.succeed("a");
    g.fail("a");
    expect(g.check("a").allowed).toBe(true);
  });

  it("pauses everyone when failures arrive from many places at once", () => {
    const c = clock();
    const g = new LoginGuard({ now: c.now, globalMaxFailures: 10, globalLockMs: 5 * MIN });
    for (let i = 0; i < 10; i++) g.fail(`ip-${i}`);
    expect(g.check("someone-new")).toMatchObject({ allowed: false, scope: "panel", retryAfterSec: 300 });
    c.advance(5 * MIN + 1);
    expect(g.check("someone-new").allowed).toBe(true);
  });

  it("forgets visitors so the table cannot grow without bound", () => {
    const c = clock();
    const g = new LoginGuard({ now: c.now, globalMaxFailures: 1_000_000 });
    for (let i = 0; i < 10_050; i++) g.fail(`ip-${i}`);
    expect((g as unknown as { entries: Map<string, unknown> }).entries.size).toBeLessThanOrEqual(10_000);
  });
});

describe("visitorKey", () => {
  it("leaves IPv4 alone and unwraps IPv4-mapped addresses", () => {
    expect(visitorKey("203.0.113.9")).toBe("203.0.113.9");
    expect(visitorKey("::ffff:203.0.113.9")).toBe("203.0.113.9");
  });
  it("groups IPv6 by its /64, however it is written", () => {
    const a = visitorKey("2001:db8:1:2:aaaa:bbbb:cccc:dddd");
    expect(a).toBe("2001:db8:1:2::/64");
    expect(visitorKey("2001:0db8:0001:0002::1")).toBe(a);
    expect(visitorKey("2001:DB8:1:2:ffff::")).toBe(a);
    expect(visitorKey("2001:db8:1:3::1")).not.toBe(a);
    expect(visitorKey("::1")).toBe("0:0:0:0::/64");
  });
});
