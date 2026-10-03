import { describe, expect, it } from "vitest";
import { allocatePorts, checkPorts, PortConflictError, portKey } from "../src/server/ports/allocator.js";
import type { TemplatePort } from "../src/shared/template.js";

const udp = (name: string, p: number): TemplatePort => ({ name, default: p, protocol: "udp", query: "none" });
const tcp = (name: string, p: number): TemplatePort => ({ name, default: p, protocol: "tcp", query: "none" });
const none = new Set<never>();

describe("allocatePorts", () => {
  it("uses template defaults when free", () => {
    expect(allocatePorts([udp("game", 8211), udp("query", 27015)], none, none).map((a) => a.port)).toEqual([8211, 27015]);
  });

  it("increments past ports owned by other servers (two games defaulting to 7777)", () => {
    const first = allocatePorts([udp("game", 7777)], none, none);
    const taken = new Set(first.map((a) => portKey(a.port, a.protocol)));
    expect(allocatePorts([udp("game", 7777)], taken, none)[0].port).toBe(7778);
  });

  it("increments past ports the host is already listening on", () => {
    const busy = new Set([portKey(25565, "tcp")]);
    expect(allocatePorts([tcp("game", 25565)], none, busy)[0].port).toBe(25566);
  });

  it("allows the same port number on different protocols", () => {
    const taken = new Set([portKey(7777, "udp")]);
    expect(allocatePorts([tcp("game", 7777)], taken, none)[0].port).toBe(7777);
  });

  it("keeps multi-port games a contiguous block", () => {
    const taken = new Set([portKey(2457, "udp")]); // blocks the second port at shift 0
    const out = allocatePorts([udp("game", 2456), udp("query", 2457)], taken, none);
    expect(out.map((a) => a.port)).toEqual([2458, 2459]);
  });

  it("carries the env var name through", () => {
    const p: TemplatePort = { ...udp("game", 8211), env: "PORT" };
    expect(allocatePorts([p], none, none)[0].env).toBe("PORT");
  });
});

describe("checkPorts", () => {
  const tpl = [udp("game", 7777)];

  it("hard-blocks duplicate (port, protocol) pairs with a suggestion", () => {
    const taken = new Set([portKey(7777, "udp")]);
    try {
      checkPorts([{ name: "game", port: 7777, protocol: "udp" }], tpl, taken, none);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(PortConflictError);
      expect((e as PortConflictError).conflicts).toEqual(["7777/udp"]);
      expect((e as PortConflictError).suggestion?.[0].port).toBe(7778);
    }
  });

  it("rejects the same pair twice within one request", () => {
    expect(() =>
      checkPorts([{ name: "a", port: 9000, protocol: "tcp" }, { name: "b", port: 9000, protocol: "tcp" }], tpl, none, none),
    ).toThrow(PortConflictError);
  });

  it("passes when everything is free", () => {
    expect(() => checkPorts([{ name: "game", port: 7780, protocol: "udp" }], tpl, none, none)).not.toThrow();
  });
});
