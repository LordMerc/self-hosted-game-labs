import { beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/server/config.js";
import { openDb } from "../src/server/db/index.js";
import { parseListeningUdp, ServerService, UserError } from "../src/server/servers/service.js";
import { loadTemplates } from "../src/server/templates/loader.js";
import { FakeConnectivity, FakeDns, FakeDocker } from "./helpers/fakes.js";

let docker: FakeDocker;
let net: FakeConnectivity;
let dns: FakeDns;
let svc: ServerService;
let dir: string;
let playersAnswer = true;
let hostBusy: Set<`${number}/${"tcp" | "udp"}`>;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "gl-"));
  const config = loadConfig({
    SESSION_SECRET: "x".repeat(32),
    DATA_DIR: dir,
    GAMESERVERS_DIR: path.join(dir, "games"),
    HOST_LAN_IP: "192.168.1.50",
    PUBLIC_HOST: "play.example.com",
    CF_ZONE: "example.com",
  });
  docker = new FakeDocker();
  net = new FakeConnectivity();
  dns = new FakeDns();
  hostBusy = new Set();
  svc = new ServerService({
    config,
    db: openDb(":memory:").db,
    templates: loadTemplates(path.resolve("templates")),
    docker,
    connectivity: net,
    dns,
    hostPorts: () => hostBusy,
    background: false,
    stableMs: 0,
    readyTimeoutMs: 2000,
    queryPlayers: async () => (playersAnswer ? { online: 4, max: 32 } : null),
  });
});

const deploy = (name = "Our Palworld", extra: object = {}) => svc.deploy({ templateId: "palworld", name, ...extra });

describe("deploy", () => {
  it("creates a labelled container with ports passed through env and a data dir, and reaches online", async () => {
    const id = await deploy();
    const [s] = await svc.list();
    expect(s.id).toBe(id);
    expect(s.status).toBe("online");
    expect(s.slug).toBe("our-palworld");
    const [c] = [...docker.containers.values()];
    expect(c.spec.labels).toMatchObject({ "gamelabs.managed": "true", "gamelabs.slug": "our-palworld" });
    expect(c.spec.env).toMatchObject({ PORT: "8211", QUERY_PORT: "27015" });
    expect(c.spec.ports).toEqual([{ port: 8211, protocol: "udp" }, { port: 27015, protocol: "udp" }]);
    expect(existsSync(path.join(dir, "games", "our-palworld"))).toBe(true);
    expect(c.spec.binds[0].container).toBe("/palworld");
  });

  it("generates secrets, never returns them in the list, and reveals them only on request", async () => {
    const id = await deploy();
    const [s] = await svc.list();
    expect(JSON.stringify(s)).not.toContain(docker.containers.values().next().value!.spec.env.ADMIN_PASSWORD);
    expect(s.secrets).toContain("ADMIN_PASSWORD");
    expect(svc.secret(id, "ADMIN_PASSWORD").length).toBeGreaterThan(8);
    expect(() => svc.secret(id, "SERVER_NAME")).toThrow(UserError);
  });

  it("gives two servers from the same template distinct ports and slugs", async () => {
    await deploy();
    await deploy();
    const list = await svc.list();
    expect(list.map((s) => s.slug).sort()).toEqual(["our-palworld", "our-palworld-2"]);
    expect(list[0].ports[0].port).not.toBe(list[1].ports[0].port);
  });

  it("skips ports the host is already using", async () => {
    hostBusy.add("8211/udp");
    await deploy();
    expect((await svc.list())[0].ports[0].port).toBe(8212);
  });

  it("rejects a manually chosen duplicate port with a suggestion", async () => {
    await deploy();
    await expect(deploy("Second", { ports: { game: 8211, query: 27099 } })).rejects.toMatchObject({
      status: 409,
      extra: { conflicts: ["8211/udp"] },
    });
  });

  it("lands in Error with a message when the image cannot be pulled, and retry recovers", async () => {
    docker.failPull = true;
    const id = await deploy();
    const [s] = await svc.list();
    expect(s.status).toBe("error");
    expect(s.lastError).toMatch(/pull access denied/);
    docker.failPull = false;
    await svc.retry(id);
    expect((await svc.list())[0].status).toBe("online");
    expect(docker.containers.size).toBe(1);
  });

  it("reports a container that crashes at startup as an error", async () => {
    docker.crashOnStart = true;
    await deploy();
    const [s] = await svc.list();
    expect(s.status).toBe("error");
    expect(s.lastError).toMatch(/stopped during startup/);
  });
});

describe("access", () => {
  it("public opens every port, creates DDNS and the CNAME; private removes them", async () => {
    const id = await deploy();
    await svc.setAccess(id, "public");
    expect([...net.open.keys()].sort()).toEqual(["27015/udp", "8211/udp"]);
    expect(dns.a.get("play.example.com")).toBe("203.0.113.7");
    expect(dns.cnames.get("our-palworld")).toBe("play.example.com");
    const [pub] = await svc.list();
    expect(pub.access).toBe("public");
    expect(pub.connect.public).toBe("our-palworld.example.com:8211");

    await svc.setAccess(id, "private");
    expect(net.open.size).toBe(0);
    expect(dns.cnames.size).toBe(0);
    expect((await svc.list())[0].connect.public).toBeNull();
  });

  it("stays private and reports the reason when the router refuses", async () => {
    const id = await deploy();
    net.fail = "No UPnP router found.";
    await expect(svc.setAccess(id, "public")).rejects.toMatchObject({ status: 502, message: "No UPnP router found." });
    expect((await svc.list())[0].access).toBe("private");
  });

  it("only removes mappings it owns", async () => {
    const id = await deploy();
    await svc.setAccess(id, "public");
    net.open.set("8211/udp", "someone-else");
    await svc.setAccess(id, "private");
    expect(net.open.get("8211/udp")).toBe("someone-else");
  });
});

describe("lifecycle", () => {
  it("stop, start and restart update status; status follows Docker", async () => {
    const id = await deploy();
    await svc.stop(id);
    expect((await svc.list())[0].status).toBe("offline");
    await svc.start(id);
    expect((await svc.list())[0].status).toBe("online");
    docker.containers.values().next().value!.state = "exited"; // crashed outside the panel
    expect((await svc.list())[0].status).toBe("offline");
  });

  it("delete removes container, mappings, DNS and the row, but keeps data by default", async () => {
    const id = await deploy();
    await svc.setAccess(id, "public");
    await svc.remove(id);
    expect(docker.containers.size).toBe(0);
    expect(net.open.size).toBe(0);
    expect(dns.cnames.size).toBe(0);
    expect(await svc.list()).toHaveLength(0);
    expect(existsSync(path.join(dir, "games", "our-palworld"))).toBe(true);
  });

  it("deleting world data requires typing the server name", async () => {
    const id = await deploy();
    await expect(svc.remove(id, { deleteData: true, confirmName: "nope" })).rejects.toThrow(/Type the server name/);
    await svc.remove(id, { deleteData: true, confirmName: "Our Palworld" });
    expect(existsSync(path.join(dir, "games", "our-palworld"))).toBe(false);
  });
});

describe("network", () => {
  it("reports provider, public IP and DNS status", async () => {
    await deploy();
    await svc.syncDdns();
    const n = await svc.network();
    expect(n).toMatchObject({ provider: "upnp", publicIp: "203.0.113.7", dns: { host: "play.example.com", lastIp: "203.0.113.7" } });
  });
});

describe("reconcile", () => {
  it("re-opens mappings the router forgot and restores a deleted CNAME", async () => {
    const id = await deploy();
    await svc.setAccess(id, "public");
    net.open.clear(); // simulated router reboot
    dns.cnames.clear(); // someone deleted the record
    const actions = await svc.reconcile();
    expect([...net.open.keys()].sort()).toEqual(["27015/udp", "8211/udp"]);
    expect(dns.cnames.get("our-palworld")).toBe("play.example.com");
    expect(actions.join(" ")).toMatch(/re-opened 8211\/udp/);
    expect(actions.join(" ")).toMatch(/restored DNS record/);
  });

  it("updates DDNS when the public IP changes, and does nothing when it has not", async () => {
    await deploy();
    await svc.syncDdns();
    expect((await svc.reconcile()).join(" ")).not.toMatch(/DDNS/);
    net.ip = "198.51.100.9";
    expect((await svc.reconcile()).join(" ")).toMatch(/DDNS updated \(198\.51\.100\.9\)/);
    expect(dns.a.get("play.example.com")).toBe("198.51.100.9");
  });

  it("removes tagged CNAMEs that no public server wants, and recreates a missing container", async () => {
    const id = await deploy();
    dns.cnames.set("ghost", "play.example.com");
    docker.containers.clear(); // container removed behind our back
    const actions = await svc.reconcile();
    expect(dns.cnames.has("ghost")).toBe(false);
    expect(actions.join(" ")).toMatch(/recreated missing container for our-palworld/);
    expect(docker.containers.size).toBe(1);
    expect((await svc.list()).find((s) => s.id === id)!.status).toBe("online");
  });

  it("records problems instead of throwing when the router is unreachable", async () => {
    const id = await deploy();
    await svc.setAccess(id, "public");
    net.fail = "No UPnP router found.";
    await svc.reconcile();
    expect((await svc.network()).reconcile.problems.join(" ")).toMatch(/No UPnP router found/);
  });
});

describe("reconcile and the router", () => {
  it("does not complain about a router that was missing once, only when it stays missing", async () => {
    const id = await deploy();
    await svc.setAccess(id, "public");
    net.missing = true;
    await svc.reconcile();
    expect((await svc.network()).reconcile.problems).toEqual([]);
    await svc.reconcile();
    expect((await svc.network()).reconcile.problems).toEqual(["No UPnP router found."]); // once, not once per port
    net.missing = false;
    await svc.reconcile();
    expect((await svc.network()).reconcile.problems).toEqual([]);
    net.missing = true;
    await svc.reconcile();
    expect((await svc.network()).reconcile.problems).toEqual([]); // the streak starts over
  });

  it("leaves the router alone for a stopped public server, and re-opens its ports when it starts", async () => {
    const id = await deploy();
    await svc.setAccess(id, "public");
    await svc.stop(id);
    net.open.clear();
    net.fail = "router exploded";
    await svc.reconcile();
    expect((await svc.network()).reconcile.problems.join(" ")).not.toMatch(/router exploded/);
    expect(net.open.size).toBe(0);
    net.fail = null;
    await svc.start(id);
    expect([...net.open.keys()].sort()).toEqual(["27015/udp", "8211/udp"]);
  });

  it("starting still works when the router cannot be reached", async () => {
    const id = await deploy();
    await svc.setAccess(id, "public");
    await svc.stop(id);
    net.missing = true;
    await svc.start(id);
    expect((await svc.list()).find((s) => s.id === id)!.status).toBe("online");
  });
});

describe("usage", () => {
  it("reports CPU and memory for running servers only, and skips one whose stats fail", async () => {
    const a = await deploy("Alpha");
    const b = await deploy("Bravo");
    await svc.stop(b);
    const u = await svc.usage();
    expect(Object.keys(u)).toEqual([a]);
    expect(u[a].players).toEqual({ online: 4, max: 32 });
    playersAnswer = false;
    expect((await svc.usage())[a].players).toBeNull();
    docker.usage = async () => {
      throw new Error("docker busy");
    };
    expect(await svc.usage()).toEqual({});
  });
});

describe("backups", () => {
  it("backs up, restores while stopping and restarting the game, and keeps a safety copy", async () => {
    const id = await deploy("Alpha");
    const dataFile = path.join(dir, "games", "alpha", "palworld", "world.sav");
    mkdirSync(path.dirname(dataFile), { recursive: true });
    writeFileSync(dataFile, "before");
    const b = await svc.backup(id);
    writeFileSync(dataFile, "after");
    await svc.restoreBackup(id, b.name);
    expect(readFileSync(dataFile, "utf8")).toBe("before");
    expect(docker.containers.get("c1")!.state).toBe("running");
    expect(svc.listBackups(id)).toHaveLength(2); // the one asked for plus the safety copy of "after"
  });

  it("refuses an unknown backup and a second job on the same server", async () => {
    const id = await deploy("Alpha");
    mkdirSync(path.join(dir, "games", "alpha"), { recursive: true });
    await expect(svc.restoreBackup(id, "alpha-20200101-000000.tar.gz")).rejects.toMatchObject({ status: 404 });
    const first = svc.backup(id);
    await expect(svc.backup(id)).rejects.toMatchObject({ status: 409 });
    await first;
    expect(() => svc.deleteBackup(id, "alpha-20200101-000000.tar.gz")).toThrow(UserError);
  });
});

describe("deleting a server and its data", () => {
  it("leaves a final backup behind that outlives the server, and a redeploy with the same name sees it", async () => {
    const id = await deploy("Alpha");
    const dataFile = path.join(dir, "games", "alpha", "palworld", "world.sav");
    mkdirSync(path.dirname(dataFile), { recursive: true });
    writeFileSync(dataFile, "my world");
    await svc.remove(id, { deleteData: true, confirmName: "Alpha" });
    expect(existsSync(path.join(dir, "games", "alpha"))).toBe(false);
    const again = await deploy("Alpha");
    const [b] = svc.listBackups(again);
    expect(b).toBeDefined();
    await svc.restoreBackup(again, b.name);
    expect(readFileSync(dataFile, "utf8")).toBe("my world");
  });

  it("keeps existing backups when a server is deleted without its data", async () => {
    const id = await deploy("Alpha");
    mkdirSync(path.join(dir, "games", "alpha"), { recursive: true });
    await svc.backup(id);
    await svc.remove(id);
    expect(svc.listBackups(await deploy("Alpha"))).toHaveLength(1);
  });
});

describe("backup settings", () => {
  it("are per server, validated, and survive deleting the server", async () => {
    const id = await deploy("Alpha");
    expect(svc.backupSettings(id)).toEqual({ keep: 7, minDays: 7, everyHours: 24 });
    expect(svc.setBackupSettings(id, { keep: 5, minDays: 0, everyHours: 24 })).toEqual({ keep: 5, minDays: 0, everyHours: 24 });
    expect(() => svc.setBackupSettings(id, { keep: 0 })).toThrow(UserError);
    await svc.remove(id);
    expect(svc.backupSettings(await deploy("Alpha"))).toEqual({ keep: 5, minDays: 0, everyHours: 24 });
  });
});

describe("scheduled backups", () => {
  const hours = (n: number) => Date.now() + n * 3_600_000;
  const makeData = (slug: string) => mkdirSync(path.join(dir, "games", slug), { recursive: true });

  it("backs up when due, not before, and not when switched off", async () => {
    const id = await deploy("Alpha");
    makeData("alpha");
    expect(await svc.runScheduledBackups(hours(0))).toHaveLength(1); // never backed up yet
    expect(await svc.runScheduledBackups(hours(1))).toEqual([]); // daily: not due
    expect(await svc.runScheduledBackups(hours(25))).toHaveLength(1);
    svc.setBackupSettings(id, { everyHours: 0 });
    expect(await svc.runScheduledBackups(hours(100))).toEqual([]);
    svc.setBackupSettings(id, { everyHours: 2 });
    expect(await svc.runScheduledBackups(hours(100))).toHaveLength(1);
  });

  it("skips a stopped server that already has a backup, but backs up one that has none", async () => {
    const id = await deploy("Alpha");
    makeData("alpha");
    await svc.stop(id);
    expect(await svc.runScheduledBackups(hours(0))).toHaveLength(1);
    expect(await svc.runScheduledBackups(hours(100))).toEqual([]);
  });

  it("skips servers with no data folder yet", async () => {
    await deploy("Alpha");
    rmSync(path.join(dir, "games", "alpha"), { recursive: true, force: true });
    expect(await svc.runScheduledBackups()).toEqual([]);
  });
});

describe("starting", () => {
  const status = async (id: string) => (await svc.list()).find((s) => s.id === id)!;

  it("says starting until the game opens its port, then ready, and starting again after a restart", async () => {
    const id = await deploy();
    docker.gameListening = false;
    expect((await status(id)).starting).toBe(true);
    expect((await status(id)).status).toBe("online");
    docker.gameListening = true;
    expect((await status(id)).starting).toBe(false);
    docker.gameListening = false;
    expect((await status(id)).starting).toBe(false); // ready runs are remembered, not re-probed
    await svc.restart(id);
    expect((await status(id)).starting).toBe(true); // a restart is a new run
  });

  it("does not claim starting for a stopped server, or when the container cannot be inspected", async () => {
    const id = await deploy();
    docker.gameListening = false;
    docker.execFails = true;
    expect((await status(id)).starting).toBe(false);
    docker.execFails = false;
    await svc.stop(id);
    expect((await status(id)).starting).toBe(false);
  });

  it("reads bound UDP ports from /proc/net/udp, v4 and v6", () => {
    const text = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode ref pointer drops
  12: 00000000:1E61 00000000:0000 07 00000000:00000000 00:00000000 00000000  1000        0 5 2 0
   3: 00000000000000000000000000000000:20FB 00000000000000000000000000000000:0000 07 00000000:00000000 00:00000000 00000000  1000        0 6 2 0`;
    expect([...parseListeningUdp(text)].sort()).toEqual([7777, 8443]);
  });
});

describe("data folder owner", () => {
  it("sets the folder owner a template asks for, and carries on with a warning if that fails", async () => {
    const calls: [string, number, number][] = [];
    (svc as unknown as { d: { chown: unknown } }).d.chown = (d: string, u: number, g: number) => calls.push([d, u, g]);
    await svc.deploy({ templateId: "dragonwilds", name: "Dragon", env: { RSDW_OWNER_ID: "abc" } });
    expect(calls).toEqual([[path.join(dir, "games", "dragon"), 1000, 1000]]);
    (svc as unknown as { d: { chown: unknown } }).d.chown = () => {
      throw new Error("operation not permitted");
    };
    const id = await svc.deploy({ templateId: "dragonwilds", name: "Dragon Two", env: { RSDW_OWNER_ID: "abc" } });
    expect((await svc.list()).find((s) => s.id === id)!.status).toBe("online");
    expect(svc.events(id).some((e) => e.level === "warn" && /operation not permitted/.test(e.message))).toBe(true);
  });

  it("does not touch ownership for templates that do not ask", async () => {
    let called = false;
    (svc as unknown as { d: { chown: unknown } }).d.chown = () => (called = true);
    await deploy();
    expect(called).toBe(false);
  });
});
