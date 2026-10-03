import { describe, expect, it } from "vitest";
import { cleanLine } from "../web/src/LogViewer.js";

describe("cleanLine", () => {
  it("strips colour codes, NULs and carriage-return progress", () => {
    expect(cleanLine("\u001b[32mready\u001b[0m")).toBe("ready");
    expect(cleanLine("progress 10%\rprogress 99%\u0000")).toBe("progress 99%");
  });
  it("truncates absurdly long lines", () => {
    expect(cleanLine("x".repeat(5000)).length).toBe(2001);
  });
});
