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
    expect(all.map((t) => t.id)).toContain("dragonwilds");
  });

  it("gives the Dragonwilds server stable credentials and both UDP ports", () => {
    const t = loadTemplates(path.resolve("templates")).find((x) => x.id === "dragonwilds")!;
    expect(t.ports.map((p) => [p.default, p.protocol, p.env])).toEqual([
      [7777, "udp", "RSDW_PORT"],
      [8888, "udp", "RSDW_BEACON_PORT"],
    ]);
    expect(t.env.RSDW_OWNER_ID.required).toBe(true);
    // The image regenerates an unset password on every start, so the panel must always pass one.
    expect(t.env.RSDW_PASSWORD.generate).toBe(true);
    expect(t.env.RSDW_ADMIN_PASSWORD.generate).toBe(true);
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

  it("loads the Minecraft, Valheim, Satisfactory and Terraria templates", () => {
    const all = loadTemplates(path.resolve("templates"));
    const get = (id: string) => all.find((t) => t.id === id)!;
    expect(get("minecraft").ports[0]).toMatchObject({ default: 25565, protocol: "tcp", env: "SERVER_PORT", query: "minecraft" });
    // Valheim answers Steam's server query on the game port plus one, so both ports shift together.
    expect(get("valheim").ports.map((p) => [p.default, p.query])).toEqual([[2456, "none"], [2457, "a2s"]]);
    expect(get("satisfactory").ports.map((p) => [p.default, p.protocol])).toEqual([[7777, "udp"], [7777, "tcp"], [8888, "tcp"]]);
    expect(get("terraria").tty).toBe(true);
  });

  it("accepts choices, patterns, a command, a terminal and backup exclusions", () => {
    const t = parseTemplate(`${base}
env:
  LEVEL: { label: Level, default: easy, choices: [easy, hard], pattern: "[a-z]+" }
command: [-level, "\${LEVEL}"]
tty: true
backup: { exclude: [gamefiles, config/backups] }
`);
    expect(t.command).toEqual(["-level", "${LEVEL}"]);
    expect(t.backup.exclude).toEqual(["gamefiles", "config/backups"]);
  });

  it("rejects a command that names an unknown setting, a bad pattern, a default outside the choices and unsafe backup paths", () => {
    expect(() => parseTemplate(`${base}\ncommand: ["\${NOPE}"]`)).toThrow(/unknown setting NOPE/);
    expect(() => parseTemplate(`${base}\nenv:\n  A: { label: A, pattern: "(" }`)).toThrow(/regular expression/);
    expect(() => parseTemplate(`${base}\nenv:\n  A: { label: A, default: x, choices: [y] }`)).toThrow(/one of the choices/);
    for (const bad of ["../etc", "/abs", "a/../b", ".", "a b"]) {
      expect(() => parseTemplate(`${base}\nbackup: { exclude: ["${bad}"] }`), bad).toThrow(/Invalid template/);
    }
  });
});
