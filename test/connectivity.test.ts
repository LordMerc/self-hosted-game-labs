import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, schema } from "../src/server/db/index.js";
import { ManualProvider } from "../src/server/connectivity/manual.js";
import { ConnectivityError } from "../src/server/connectivity/provider.js";
import { parseUpnpList, UpnpProvider, type UpnpcRunner } from "../src/server/connectivity/upnp.js";

const LIST = `upnpc : miniupnpc library test client, version 2.2.5.
Found valid IGD : http://192.168.1.1:5000/ctl/IPConn
ExternalIPAddress = 203.0.113.7
 i protocol exPort->inAddr:inPort description remoteHost leaseTime
 0 UDP  8211->192.168.1.50:8211  'gamelabs:palworld' '' 0
 1 TCP  32400->192.168.1.20:32400 'Plex' '' 0
`;

function fakeUpnpc(initial = LIST) {
  const calls: string[][] = [];
  const run: UpnpcRunner = async (args) => {
    calls.push(args);
    return args[0] === "-l" ? initial : "";
  };
  return { calls, run };
}

describe("parseUpnpList", () => {
  it("reads mappings and the external IP", () => {
    const r = parseUpnpList(LIST);
    expect(r.externalIp).toBe("203.0.113.7");
    expect(r.entries).toEqual([
      { protocol: "udp", port: 8211, internalIp: "192.168.1.50", internalPort: 8211, description: "gamelabs:palworld" },
      { protocol: "tcp", port: 32400, internalIp: "192.168.1.20", internalPort: 32400, description: "Plex" },
    ]);
  });
});

describe("UpnpProvider", () => {
  it("adds a tagged mapping with the right upnpc arguments", async () => {
    const { run, calls } = fakeUpnpc("ExternalIPAddress = 1.2.3.4\n");
    await new UpnpProvider(run).ensureOpen("id", "viking", 2456, "udp", "192.168.1.50");
    expect(calls.at(-1)).toEqual(["-e", "gamelabs:viking", "-a", "192.168.1.50", "2456", "2456", "UDP"]);
  });

  it("does nothing when the mapping already exists as ours", async () => {
    const { run, calls } = fakeUpnpc();
    await new UpnpProvider(run).ensureOpen("id", "palworld", 8211, "udp", "192.168.1.50");
    expect(calls).toEqual([["-l"]]);
  });

  it("refuses to take over a port forwarded by something else", async () => {
    const { run } = fakeUpnpc();
    await expect(new UpnpProvider(run).ensureOpen("id", "x", 32400, "tcp", "192.168.1.50")).rejects.toThrow(/already forwarded.*Plex/);
  });

  it("closing removes only our own mapping and leaves others alone", async () => {
    const { run, calls } = fakeUpnpc();
    const p = new UpnpProvider(run);
    await p.ensureClosed("id", "palworld", 8211, "udp");
    expect(calls.at(-1)).toEqual(["-d", "8211", "UDP"]);
    calls.length = 0;
    await p.ensureClosed("id", "palworld", 32400, "tcp"); // Plex's
    await p.ensureClosed("id", "other-slug", 8211, "udp"); // someone else's slug
    expect(calls.every((c) => c[0] === "-l")).toBe(true);
  });

  it("lists only gamelabs mappings", async () => {
    expect((await new UpnpProvider(fakeUpnpc().run).list()).map((m) => m.port)).toEqual([8211]);
  });

  it("gives a clear error when UPnP is off on the router", async () => {
    const run: UpnpcRunner = async () => "No IGD UPnP Device found on the network !\n";
    await expect(new UpnpProvider(run).ensureOpen("id", "x", 9000, "tcp", "192.168.1.50")).rejects.toThrow(/Turn UPnP on/);
    await expect(new UpnpProvider(run).externalIp()).rejects.toBeInstanceOf(ConnectivityError);
  });

  it("falls back to the IP echo when the router does not report its external IP", async () => {
    const noIp: UpnpcRunner = async () => "Found valid IGD : http://192.168.68.1:5000/ctl/IPConn\n";
    expect(await new UpnpProvider(noIp, async () => "198.51.100.4").externalIp()).toBe("198.51.100.4");
    await expect(new UpnpProvider(noIp).externalIp()).rejects.toThrow(/did not report/);
    const zero: UpnpcRunner = async () => "ExternalIPAddress = 0.0.0.0\n";
    expect(await new UpnpProvider(zero, async () => "198.51.100.4").externalIp()).toBe("198.51.100.4");
  });

  it("reads the external IP from the router", async () => {
    expect(await new UpnpProvider(fakeUpnpc().run).externalIp()).toBe("203.0.113.7");
  });
});

describe("ManualProvider", () => {
  const setup = () => {
    const { db } = openDb(":memory:");
    db.insert(schema.servers).values({ id: "s1", slug: "palworld", name: "Palworld", templateId: "palworld", createdAt: new Date() }).run();
    const fetchFn = (async () => new Response("198.51.100.4\n")) as unknown as typeof fetch;
    return { db, p: new ManualProvider(db, "https://echo.test", fetchFn) };
  };

  it("is pending (with the exact rule) until confirmed, then open", async () => {
    const { db, p } = setup();
    const r = await p.ensureOpen("s1", "palworld", 8211, "udp", "192.168.1.50");
    expect(r).toMatchObject({ state: "pending" });
    expect((r as { instructions: string }).instructions).toContain("UDP 8211 to 192.168.1.50:8211");
    expect(await p.list()).toEqual([]);
    db.update(schema.manualRules).set({ confirmed: true }).run();
    expect(await p.ensureOpen("s1", "palworld", 8211, "udp", "192.168.1.50")).toEqual({ state: "open" });
    expect(await p.list()).toEqual([{ port: 8211, protocol: "udp", description: "gamelabs:palworld" }]);
  });

  it("forgets the rule when closed, and uses the IP echo for the external IP", async () => {
    const { p } = setup();
    await p.ensureOpen("s1", "palworld", 8211, "udp", "192.168.1.50");
    await p.ensureClosed("s1", "palworld", 8211, "udp");
    expect(await p.externalIp()).toBe("198.51.100.4");
    const again = await p.ensureOpen("s1", "palworld", 8211, "udp", "192.168.1.50");
    expect(again.state).toBe("pending");
  });
});
