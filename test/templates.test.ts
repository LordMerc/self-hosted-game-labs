import { describe, expect, it } from "vitest";
import path from "node:path";
import { loadTemplates, parseTemplate } from "../src/server/templates/loader.js";

const base = `
id: demo
name: Demo
image: example/demo:1
ports:
  - { name: game, default: 7777, protocol: udp }
`;

describe("template validation", () => {
  it("loads every shipped template", () => {
    const all = loadTemplates(path.resolve("templates"));
    expect(all.map((t) => t.id)).toContain("palworld");
  });

  it("applies defaults", () => {
    const t = parseTemplate(base);
    expect(t.join.method).toBe("direct");
    expect(t.ports[0].query).toBe("none");
    expect(t.readiness.type).toBe("port-listening");
  });

  it.each(["privileged: true", "networkMode: host", "binds: ['/:/host']"])("rejects unsupported container option (%s)", (line) => {
    expect(() => parseTemplate(`${base}\n${line}`)).toThrow(/Invalid template/);
  });

  it("rejects duplicate ports within a template", () => {
    expect(() => parseTemplate(`${base}  - { name: other, default: 7777, protocol: udp }`)).toThrow(/duplicate port 7777\/udp/);
  });

  it("rejects a port env that is also a user input", () => {
    const src = `${base.replace("protocol: udp }", "protocol: udp, env: PORT }")}\nenv:\n  PORT: { label: Port }`;
    expect(() => parseTemplate(src)).toThrow(/cannot also be a user input/);
  });

  it("requires instructions for server-browser games", () => {
    expect(() => parseTemplate(`${base}\njoin: { method: server-browser }`)).toThrow(/instructions/);
  });

  it("rejects privileged ports", () => {
    expect(() => parseTemplate(base.replace("7777", "80"))).toThrow(/Invalid template/);
  });
});
