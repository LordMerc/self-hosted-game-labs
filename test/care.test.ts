import { describe, expect, it } from "vitest";
import { compareVersions, dayKey, dueStatus, isDockerHubImage, newestTag, repoOf, tagOf } from "../src/server/care.js";

const at = (h: number, m: number) => new Date(2026, 9, 3, h, m, 0);

describe("dueStatus", () => {
  it("counts down to the time, is due from the time on, and not again once it ran today", () => {
    expect(dueStatus("04:00", at(3, 0), null)).toEqual({ now: false, minutesLeft: 60 });
    expect(dueStatus("04:00", at(3, 59), null)).toEqual({ now: false, minutesLeft: 1 });
    expect(dueStatus("04:00", at(4, 0), null)).toEqual({ now: true, minutesLeft: null });
    expect(dueStatus("04:00", at(4, 0), dayKey(at(4, 0)))).toEqual({ now: false, minutesLeft: null });
    expect(dueStatus("04:00", at(3, 0), "2026-10-02").minutesLeft).toBe(60);
  });

  it("catches up for an hour after the time and then waits for tomorrow", () => {
    expect(dueStatus("04:00", at(5, 0), null).now).toBe(true);
    expect(dueStatus("04:00", at(5, 1), null).now).toBe(false);
  });
});

describe("versions", () => {
  it("compares tags by their numbers, not as text", () => {
    expect(compareVersions("v2.10.0", "v2.9.9")).toBeGreaterThan(0);
    expect(compareVersions("v2.8.0", "v2.8")).toBe(0);
    expect(compareVersions("v1.0.5", "v2.0.0")).toBeLessThan(0);
  });

  it("picks the newest tag that matches the pattern", () => {
    const re = "^v\\d+\\.\\d+\\.\\d+$";
    expect(newestTag(["latest", "v2.8.0", "v2.10.1", "v2.9.0", "v3.0.0-wine", "dev"], re)).toBe("v2.10.1");
    expect(newestTag(["latest"], re)).toBeNull();
  });

  it("splits an image name into repository and tag, and knows which are on Docker Hub", () => {
    expect(tagOf("thijsvanloef/palworld-server-docker:v2.8.0")).toBe("v2.8.0");
    expect(tagOf("itzg/minecraft-server")).toBe("latest");
    expect(tagOf("localhost:5000/game")).toBe("latest");
    expect(repoOf("ghcr.io/runescape/rsdw-dedicated:latest")).toBe("ghcr.io/runescape/rsdw-dedicated");
    expect(repoOf("localhost:5000/game:1")).toBe("localhost:5000/game");
    expect(isDockerHubImage("thijsvanloef/palworld-server-docker:v2.8.0")).toBe(true);
    expect(isDockerHubImage("redis")).toBe(true);
    expect(isDockerHubImage("ghcr.io/runescape/rsdw-dedicated:latest")).toBe(false);
    expect(isDockerHubImage("localhost:5000/game")).toBe(false);
  });
});
