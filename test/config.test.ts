import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/server/config.js";

const base = { SESSION_SECRET: "x".repeat(32) };

describe("loadConfig", () => {
  it("defaults the game data directory", () => {
    expect(loadConfig(base).GAMESERVERS_DIR).toBe("/srv/gameservers");
  });
  it("accepts a path on another drive and rejects a relative one", () => {
    expect(loadConfig({ ...base, GAMESERVERS_DIR: "/mnt/games" }).GAMESERVERS_DIR).toBe("/mnt/games");
    expect(() => loadConfig({ ...base, GAMESERVERS_DIR: "games" })).toThrow(/absolute path/);
  });
});
