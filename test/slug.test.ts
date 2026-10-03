import { describe, expect, it } from "vitest";
import { slugify, uniqueSlug } from "../src/server/slug.js";

describe("slug", () => {
  it("slugifies names", () => {
    expect(slugify("Viking Realm!")).toBe("viking-realm");
    expect(slugify("  ")).toBe("server");
  });
  it("suffixes duplicates", () => {
    expect(uniqueSlug("palworld", new Set(["palworld", "palworld-2"]))).toBe("palworld-3");
  });
});
