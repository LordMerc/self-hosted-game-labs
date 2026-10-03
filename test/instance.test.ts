import { describe, expect, it } from "vitest";
import { DEFAULT_INSTANCE, names, namesFor, parseInstance } from "../src/server/instance.js";

describe("instance naming", () => {
  it("keeps the original names for the default instance", () => {
    const n = namesFor(DEFAULT_INSTANCE);
    expect(n.labelPrefix).toBe("gamelabs");
    expect(n.ownerPrefix).toBe("gamelabs:");
    expect(n.containerName("palworld")).toBe("gl-palworld");
    expect(names.instance).toBe(DEFAULT_INSTANCE);
  });

  it("gives another instance its own container names, labels and owner prefix", () => {
    const n = namesFor("beta");
    expect(n.labelPrefix).toBe("beta");
    expect(n.ownerPrefix).toBe("beta:");
    expect(n.containerName("palworld")).toBe("gl-beta-palworld");
    // Never a prefix of the default panel's tag, so neither panel's startsWith checks match the other's records.
    expect("gamelabs:palworld".startsWith(n.ownerPrefix)).toBe(false);
    expect("beta:palworld".startsWith(namesFor(DEFAULT_INSTANCE).ownerPrefix)).toBe(false);
  });

  it("defaults when unset or blank and rejects odd names", () => {
    expect(parseInstance(undefined)).toBe("gamelabs");
    expect(parseInstance("  ")).toBe("gamelabs");
    expect(parseInstance("beta")).toBe("beta");
    expect(() => parseInstance("Beta Panel")).toThrow(/INSTANCE/);
    expect(() => parseInstance("a".repeat(21))).toThrow(/INSTANCE/);
  });
});
