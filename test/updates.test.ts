import { describe, expect, it } from "vitest";
import { openDb } from "../src/server/db/index.js";
import { compareVersions, parseVersion, runningVersion, UpdateChecker } from "../src/server/updates.js";

const release = (tag: string, url = `https://github.com/LordMerc/self-hosted-game-labs/releases/tag/${tag}`) =>
  ({ tag_name: tag, name: `Release ${tag}`, html_url: url, published_at: "2026-10-04T10:00:00Z" });

function setup(current: string, responses: (() => Response | Promise<Response>)[], envEnabled = true) {
  const { db } = openDb(":memory:");
  let t = 1_000_000_000_000;
  const calls: { url: string; init?: RequestInit }[] = [];
  const queue = [...responses];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const next = queue.shift();
    if (!next) throw new Error("unexpected request");
    return next();
  }) as unknown as typeof fetch;
  const checker = new UpdateChecker(db, { current, envEnabled, fetchFn, now: () => t });
  return { checker, calls, advance: (ms: number) => void (t += ms) };
}
const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status });
const HOUR = 3_600_000;

describe("versions", () => {
  it("compares release numbers, not text", () => {
    const cmp = (a: string, b: string) => Math.sign(compareVersions(parseVersion(a)!, parseVersion(b)!));
    expect(cmp("0.10.0", "0.9.0")).toBe(1);
    expect(cmp("v1.0.0", "1.0.0")).toBe(0);
    expect(cmp("1.0.0", "1.0.0-rc.1")).toBe(1);
    expect(cmp("0.1.0", "0.2.0")).toBe(-1);
  });
  it("does not treat development builds or junk as versions", () => {
    expect(parseVersion("dev-44dab9a")).toBeNull();
    expect(parseVersion("main")).toBeNull();
  });
  it("prefers the version the build was given, then package.json", () => {
    expect(runningVersion("1.2.3")).toBe("1.2.3");
    expect(runningVersion("")).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe("UpdateChecker", () => {
  it("reports a newer release with a link, and nothing when up to date", async () => {
    const newer = setup("0.1.0", [json(release("v0.2.0"))]);
    await newer.checker.checkIfDue();
    expect(newer.checker.state()).toMatchObject({ updateAvailable: true, latest: { version: "0.2.0", url: "https://github.com/LordMerc/self-hosted-game-labs/releases/tag/v0.2.0" }, error: null });

    const same = setup("0.2.0", [json(release("v0.2.0"))]);
    await same.checker.checkIfDue();
    expect(same.checker.state().updateAvailable).toBe(false);
  });

  it("asks GitHub at most once a day, and sends nothing but the program name and version", async () => {
    const { checker, calls, advance } = setup("0.1.0", [json(release("v0.2.0")), json(release("v0.2.0"))]);
    await checker.checkIfDue();
    advance(23 * HOUR);
    await checker.checkIfDue();
    expect(calls).toHaveLength(1);
    advance(2 * HOUR);
    await checker.checkIfDue();
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe("https://api.github.com/repos/LordMerc/self-hosted-game-labs/releases/latest");
    expect(calls[0].init?.headers).toEqual({ accept: "application/vnd.github+json", "user-agent": "self-hosted-game-labs/0.1.0" });
  });

  it("does nothing while switched off, from the Settings toggle or the environment", async () => {
    const toggled = setup("0.1.0", []);
    toggled.checker.setEnabled(false);
    await toggled.checker.checkIfDue();
    expect(toggled.calls).toHaveLength(0);
    expect(toggled.checker.state()).toMatchObject({ enabled: false, updateAvailable: false });

    const env = setup("0.1.0", [], false);
    env.checker.setEnabled(true);
    await env.checker.checkIfDue();
    expect(env.calls).toHaveLength(0);
    expect(env.checker.state()).toMatchObject({ enabled: false, lockedByEnv: true });
  });

  it("hides a known update while switched off, and shows it again when switched on", async () => {
    const { checker } = setup("0.1.0", [json(release("v0.2.0"))]);
    await checker.checkIfDue();
    checker.setEnabled(false);
    expect(checker.state().updateAvailable).toBe(false);
    checker.setEnabled(true);
    expect(checker.state().updateAvailable).toBe(true);
  });

  it("skips development builds, which have no release number", async () => {
    const { checker, calls } = setup("dev-44dab9a", [json(release("v0.2.0"))]);
    await checker.checkIfDue();
    expect(await checker.checkNow()).toBe(false);
    expect(calls).toHaveLength(0);
    expect(checker.state()).toMatchObject({ comparable: false, updateAvailable: false });
  });

  it("keeps the last good answer when a later check fails, and retries within the hour", async () => {
    const { checker, calls, advance } = setup("0.1.0", [json(release("v0.2.0")), () => new Response("nope", { status: 403 }), json(release("v0.3.0"))]);
    await checker.checkIfDue();
    advance(25 * HOUR);
    await checker.checkIfDue();
    expect(checker.state()).toMatchObject({ updateAvailable: true, latest: { version: "0.2.0" }, error: "GitHub answered 403" });
    advance(30 * 60_000);
    await checker.checkIfDue();
    expect(calls).toHaveLength(2);
    advance(31 * 60_000);
    await checker.checkIfDue();
    expect(checker.state()).toMatchObject({ latest: { version: "0.3.0" }, error: null });
  });

  it("survives a network error", async () => {
    const { checker } = setup("0.1.0", [() => Promise.reject(new Error("offline"))]);
    await checker.checkIfDue();
    expect(checker.state()).toMatchObject({ updateAvailable: false, latest: null, error: "offline" });
  });

  it("refuses a release that links anywhere but this project's GitHub pages, or has no version", async () => {
    const evil = setup("0.1.0", [json(release("v9.9.9", "https://evil.example/download"))]);
    await evil.checker.checkIfDue();
    expect(evil.checker.state()).toMatchObject({ updateAvailable: false, latest: null });
    const junk = setup("0.1.0", [json(release("nightly"))]);
    await junk.checker.checkIfDue();
    expect(junk.checker.state().updateAvailable).toBe(false);
  });

  it("lets Check now run, but not twice in a minute", async () => {
    const { checker, calls, advance } = setup("0.1.0", [json(release("v0.2.0")), json(release("v0.2.0"))]);
    expect(await checker.checkNow()).toBe(true);
    advance(10_000);
    expect(await checker.checkNow()).toBe(false);
    advance(61_000);
    expect(await checker.checkNow()).toBe(true);
    expect(calls).toHaveLength(2);
  });
});
