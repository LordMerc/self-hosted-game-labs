import { describe, expect, it } from "vitest";
import { parsePalworldMetrics } from "../src/server/players/palworld.js";

const metrics = `{
\t"currentplayernum": 3,
\t"serverfps": 59,
\t"days": 33,
\t"maxplayernum": 32,
\t"uptime": 17108
}`;

describe("parsePalworldMetrics", () => {
  it("reads players and max players", () => expect(parsePalworldMetrics(metrics)).toEqual({ online: 3, max: 32 }));
  it("reads zero players", () => expect(parsePalworldMetrics('{"currentplayernum":0,"maxplayernum":32}')).toEqual({ online: 0, max: 32 }));
  it("ignores text around the JSON", () => expect(parsePalworldMetrics(`\x01\x00\x00\x00${metrics}\n`)).toEqual({ online: 3, max: 32 }));
  it("keeps the count when the limit is missing", () => expect(parsePalworldMetrics('{"currentplayernum":2}')).toEqual({ online: 2, max: 0 }));
  it("rejects anything else", () => {
    expect(parsePalworldMetrics("")).toBeNull();
    expect(parsePalworldMetrics("curl: (7) Failed to connect")).toBeNull();
    expect(parsePalworldMetrics('{"error":"unauthorized"}')).toBeNull();
    expect(parsePalworldMetrics('{"currentplayernum":"3"}')).toBeNull();
    expect(parsePalworldMetrics("{not json}")).toBeNull();
  });
});
