import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/server/config.js";
import { openDb } from "../src/server/db/index.js";
import { parseListeningUdp, REACH_MAX_AGE_MS, ServerService, UserError } from "../src/server/servers/service.js";
import { loadTemplates } from "../src/server/templates/loader.js";
import type { TcpProbe } from "../src/server/reachability.js";
import { FakeConnectivity, FakeDns, FakeDocker } from "./helpers/fakes.js";

let docker: FakeDocker;
let net: FakeConnectivity;
let dns: FakeDns;
let svc: ServerService;
let dir: string;
let playersAnswer = true;
const probeCalls: [string, number][] = [];
let probeAnswer: { state: "open" | "closed" | "unknown"; detail: string } = { state: "open", detail: "Connected from 3 of 3 locations" };
const probe: TcpProbe = { name: "fake-checker", check: async (ip, port) => (probeCalls.push([ip, port]), probeAnswer) };
let hostBusy: Set<`${number}/${"tcp" | "udp"}`>;
let hubTags: string[] = [];
let hubFails = false;

beforeEach(() => {
  probeCalls.length = 0;
  hubTags = ["latest", "v2.8.0", "v2.8", "dev"];
  hubFails = false;
  probeAnswer = { state: "open", detail: "Connected from 3 of 3 locations" };
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
    portProbe: probe,
    tagLister: async () => {
      if (hubFails) throw new Error("Docker Hub answered 503");
      return hubTags;
    },
    queryPlayers: async () => (playersAnswer ? { online: 4, max: 32 } : null),
    hostCores: 8,
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

describe("backups of deleted servers", () => {
  const dataFile = () => path.join(dir, "games", "alpha", "palworld", "world.sav");
  async function deletedWithWorld() {
    const id = await deploy("Alpha", { env: { SERVER_PASSWORD: "letmein" } });
    mkdirSync(path.dirname(dataFile()), { recursive: true });
    writeFileSync(dataFile(), "my world");
    await svc.backup(id);
    await svc.remove(id, { deleteData: true, confirmName: "Alpha" });
    return svc.allBackups().find((g) => g.slug === "alpha")!;
  }

  it("lists current and deleted servers together, marks the deleted ones, and never lists passwords", async () => {
    const live = await deploy("Beta");
    mkdirSync(path.join(dir, "games", "beta"), { recursive: true });
    await svc.backup(live);
    const gone = await deletedWithWorld();
    expect(gone).toMatchObject({ deleted: true, serverId: null, name: "Alpha", templateId: "palworld" });
    expect(gone.backups.length).toBeGreaterThanOrEqual(2); // the manual one and the final one
    expect(gone.saved!.savedSecrets).toEqual(expect.arrayContaining(["SERVER_PASSWORD", "ADMIN_PASSWORD"]));
    expect(JSON.stringify(gone)).not.toContain("letmein");
    const groups = svc.allBackups();
    expect(groups.map((g) => [g.slug, g.deleted])).toEqual([["beta", false], ["alpha", true]]);
  });

  it("sets a deleted server up again with the same game and passwords, and its world in place before it starts", async () => {
    const gone = await deletedWithWorld();
    const id = await svc.redeployFromBackup("alpha", gone.backups[0].name);
    expect(readFileSync(dataFile(), "utf8")).toBe("my world");
    const [s] = await svc.list();
    expect(s).toMatchObject({ id, slug: "alpha", name: "Alpha", templateId: "palworld", status: "online", access: "private" });
    expect(svc.secret(id, "SERVER_PASSWORD")).toBe("letmein");
    expect(svc.allBackups().find((g) => g.slug === "alpha")).toMatchObject({ deleted: false, serverId: id });
  });

  it("lets the user rename it and replace a password, restoring into the new name", async () => {
    const gone = await deletedWithWorld();
    const id = await svc.redeployFromBackup("alpha", gone.backups[0].name, { name: "Gamma", env: { SERVER_PASSWORD: "new" } });
    expect(readFileSync(path.join(dir, "games", "gamma", "palworld", "world.sav"), "utf8")).toBe("my world");
    expect(svc.secret(id, "SERVER_PASSWORD")).toBe("new");
    expect(svc.allBackups().find((g) => g.slug === "alpha")!.deleted).toBe(true); // the old backups stay where they were
  });

  it("works without saved settings: asks for the game, then uses the template defaults", async () => {
    const gone = await deletedWithWorld();
    rmSync(path.join(dir, "games", ".backups", "alpha", "server.json"));
    const g = svc.allBackups().find((x) => x.slug === "alpha")!;
    expect(g).toMatchObject({ name: "alpha", saved: null, templateId: null });
    await expect(svc.redeployFromBackup("alpha", gone.backups[0].name)).rejects.toMatchObject({ status: 400 });
    const id = await svc.redeployFromBackup("alpha", gone.backups[0].name, { templateId: "palworld", name: "Alpha" });
    expect(readFileSync(dataFile(), "utf8")).toBe("my world");
    expect((await svc.list()).find((s) => s.id === id)!.status).toBe("online");
  });

  it("replaces data left on disk after keeping a copy of it, and refuses when the server still exists or the backup is unknown", async () => {
    const gone = await deletedWithWorld();
    mkdirSync(path.dirname(dataFile()), { recursive: true });
    writeFileSync(dataFile(), "newer leftovers");
    const before = svc.allBackups().find((g) => g.slug === "alpha")!.backups.length;
    const id = await svc.redeployFromBackup("alpha", gone.backups[0].name);
    expect(readFileSync(dataFile(), "utf8")).toBe("my world");
    expect(svc.allBackups().find((g) => g.slug === "alpha")!.backups).toHaveLength(before + 1);
    await expect(svc.redeployFromBackup("alpha", gone.backups[0].name)).rejects.toMatchObject({ status: 409 });
    await svc.remove(id);
    await expect(svc.redeployFromBackup("alpha", "alpha-20200101-000000.tar.gz")).rejects.toMatchObject({ status: 404 });
  });

  it("deletes a backup of a deleted server by name, and rejects names that are not backups", async () => {
    const gone = await deletedWithWorld();
    svc.deleteBackupBySlug("alpha", gone.backups[0].name);
    expect(svc.allBackups().find((g) => g.slug === "alpha")!.backups).toHaveLength(gone.backups.length - 1);
    expect(() => svc.deleteBackupBySlug("alpha", "../../x")).toThrow(UserError);
    expect(() => svc.deleteBackupBySlug("../..", "alpha-20200101-000000.tar.gz")).toThrow(UserError);
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

describe("server page: detail, settings, console", () => {
  it("shows editable settings without leaking secrets", async () => {
    const id = await deploy("Alpha", { env: { SERVER_NAME: "Hello", SERVER_PASSWORD: "hunter2" } });
    const d = await svc.detail(id);
    const byKey = Object.fromEntries(d.env.map((e) => [e.key, e]));
    expect(byKey.SERVER_NAME).toMatchObject({ value: "Hello", secret: false });
    expect(byKey.SERVER_PASSWORD).toMatchObject({ value: null, secret: true, isSet: true });
    expect(JSON.stringify(d)).not.toContain("hunter2");
    expect(d.console?.examples.length).toBeGreaterThan(0);
    expect(d.server.id).toBe(id);
  });

  it("a name-only change is instant and does not touch the container", async () => {
    const id = await deploy("Alpha");
    const before = docker.containers.size;
    expect(await svc.updateSettings(id, { name: "Renamed" })).toEqual({ restarting: false });
    expect((await svc.list()).find((s) => s.id === id)!.name).toBe("Renamed");
    expect(docker.containers.size).toBe(before);
    expect(docker.pulled).toHaveLength(1); // only the deploy pulled
  });

  it("changing a setting recreates the container with the new value, keeps data and ports, and does not pull again", async () => {
    const id = await deploy("Alpha");
    const dataFile = path.join(dir, "games", "alpha", "palworld", "keep.txt");
    mkdirSync(path.dirname(dataFile), { recursive: true });
    writeFileSync(dataFile, "world");
    const portsBefore = (await svc.list())[0].ports;
    expect(await svc.updateSettings(id, { env: { SERVER_NAME: "New name" } })).toEqual({ restarting: true });
    expect(docker.containers.size).toBe(1);
    expect([...docker.containers.values()][0].spec.env.SERVER_NAME).toBe("New name");
    const s = (await svc.list())[0];
    expect(s.status).toBe("online");
    expect(s.ports).toEqual(portsBefore);
    expect(readFileSync(dataFile, "utf8")).toBe("world");
    expect(docker.pulled).toHaveLength(1);
  });

  it("leaves a setting alone when it is not sent, clears an optional one when empty, and makes a new generated password when emptied", async () => {
    const id = await deploy("Alpha", { env: { SERVER_PASSWORD: "hunter2", SERVER_NAME: "Keep me" } });
    const adminBefore = svc.secret(id, "ADMIN_PASSWORD");
    await svc.updateSettings(id, { env: { SERVER_PASSWORD: "" } });
    expect(() => svc.secret(id, "SERVER_PASSWORD")).not.toThrow();
    expect(svc.secret(id, "SERVER_PASSWORD")).toBe("");
    expect(svc.secret(id, "ADMIN_PASSWORD")).toBe(adminBefore);
    await svc.updateSettings(id, { env: { ADMIN_PASSWORD: "" } });
    expect(svc.secret(id, "ADMIN_PASSWORD")).not.toBe(adminBefore);
    expect(svc.secret(id, "ADMIN_PASSWORD").length).toBeGreaterThan(8);
  });

  it("rejects unknown settings, empty required ones, bad names, and changes while starting", async () => {
    const dragon = await svc.deploy({ templateId: "dragonwilds", name: "Dragon", env: { RSDW_OWNER_ID: "abc" } });
    await expect(svc.updateSettings(dragon, { env: { RSDW_OWNER_ID: "" } })).rejects.toThrow(/required/);
    await expect(svc.updateSettings(dragon, { env: { NOPE: "x" } })).rejects.toThrow(/Unknown setting/);
    await expect(svc.updateSettings(dragon, { name: "  " })).rejects.toThrow(/name/);
    const id = await deploy("Alpha");
    (svc as unknown as { setStatus: (i: string, s: string) => void }).setStatus(id, "updating");
    await expect(svc.updateSettings(id, { name: "x" })).rejects.toMatchObject({ status: 409 });
  });

  it("runs a console command as one argument inside the container, only while running", async () => {
    const id = await deploy("Alpha");
    const r = await svc.runConsole(id, "Broadcast hello there; rm -rf /");
    expect(docker.execLog.at(-1)).toEqual(["rcon-cli", "Broadcast hello there; rm -rf /"]);
    expect(r.output).toMatch(/^ran rcon-cli/);
    await expect(svc.runConsole(id, "   ")).rejects.toThrow(/Type a command/);
    await expect(svc.runConsole(id, "a\nb")).rejects.toThrow(/one line/);
    await svc.stop(id);
    await expect(svc.runConsole(id, "Save")).rejects.toMatchObject({ status: 409 });
  });

  it("has no console for a game without one", async () => {
    const id = await svc.deploy({ templateId: "dragonwilds", name: "Dragon", env: { RSDW_OWNER_ID: "abc" } });
    expect((await svc.detail(id)).console).toBeNull();
    await expect(svc.runConsole(id, "Save")).rejects.toMatchObject({ status: 404 });
  });
});

describe("template settings", () => {
  it("passes a template's command with settings filled in, and a terminal, to the container", async () => {
    const id = await svc.deploy({ templateId: "terraria", name: "Terra", env: { WORLD_NAME: "Hearth", WORLD_SIZE: "3", SERVER_PASSWORD: "pw-1" } });
    const c = docker.containers.get(docker.containers.keys().next().value!)!;
    expect(c.spec.command).toEqual(["-autocreate", "3", "-world", "/config/Hearth.wld", "-worldname", "Hearth", "-maxplayers", "8", "-port", "7777", "-password", "pw-1"]);
    expect(c.spec.tty).toBe(true);
    expect((await svc.list()).find((s) => s.id === id)!.status).toBe("online");
  });

  it("drops an empty argument, so no password leaves a bare flag at the end", async () => {
    await svc.deploy({ templateId: "terraria", name: "Terra" });
    expect([...docker.containers.values()][0].spec.command!.slice(-3)).toEqual(["-port", "7777", "-password"]);
  });

  it("does not give a terminal or a command to a game that does not ask for one", async () => {
    await svc.deploy({ templateId: "palworld", name: "Pal" });
    const spec = [...docker.containers.values()][0].spec;
    expect(spec.command).toBeUndefined();
    expect(spec.tty).toBeUndefined();
  });

  it("rejects a value that is not one of the choices or does not fit the pattern, when deploying and when changing settings", async () => {
    await expect(svc.deploy({ templateId: "minecraft", name: "MC", env: { EULA: "yes" } })).rejects.toThrow(/must be one of: TRUE/);
    await expect(svc.deploy({ templateId: "minecraft", name: "MC" })).rejects.toThrow(/required/);
    await expect(svc.deploy({ templateId: "terraria", name: "T", env: { WORLD_NAME: "my world" } })).rejects.toThrow(/can only have letters/);
    await expect(svc.deploy({ templateId: "valheim", name: "V", env: { SERVER_PASS: "abc" } })).rejects.toThrow(/at least 5 characters/);
    const id = await svc.deploy({ templateId: "minecraft", name: "MC", env: { EULA: "TRUE" } });
    await expect(svc.updateSettings(id, { env: { MEMORY: "lots" } })).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/look like 2G/) });
    await expect(svc.updateSettings(id, { env: { DIFFICULTY: "hard" } })).resolves.toEqual({ restarting: true });
  });

  it("shows a server's player count using the query kind its template names", async () => {
    const seen: [number, string][] = [];
    (svc as unknown as { d: { queryPlayers: unknown } }).d.queryPlayers = async (_h: string, port: number, kind: string) => (seen.push([port, kind]), { online: 2, max: 20 });
    const id = await svc.deploy({ templateId: "minecraft", name: "MC", env: { EULA: "TRUE" } });
    await svc.deploy({ templateId: "valheim", name: "Val" });
    const usage = await svc.usage();
    expect(usage[id].players).toEqual({ online: 2, max: 20 });
    expect(seen).toContainEqual([25565, "minecraft"]);
    expect(seen).toContainEqual([2457, "a2s"]);
  });

  it("moves Satisfactory's ports together when another server already holds 7777", async () => {
    await svc.deploy({ templateId: "dragonwilds", name: "Dragon", env: { RSDW_OWNER_ID: "abc" } });
    await svc.deploy({ templateId: "satisfactory", name: "Factory" });
    const c = [...docker.containers.values()].find((x) => x.spec.name === "gl-factory")!;
    expect(c.spec.env).toMatchObject({ SERVERGAMEPORT: "7778", SERVERMESSAGINGPORT: "8889" });
    expect(c.spec.ports.map((p) => `${p.port}/${p.protocol}`)).toEqual(["7778/udp", "7778/tcp", "8889/tcp"]);
  });

  it("keeps what a template says to leave out of backups out, and puts it back after a restore", async () => {
    const id = await svc.deploy({ templateId: "satisfactory", name: "Factory" });
    const data = path.join(dir, "games", "factory");
    mkdirSync(path.join(data, "saved"), { recursive: true });
    mkdirSync(path.join(data, "gamefiles"), { recursive: true });
    writeFileSync(path.join(data, "saved/world.sav"), "save");
    writeFileSync(path.join(data, "gamefiles/big.bin"), "x".repeat(20_000));
    const b = await svc.backup(id);
    expect(b.sizeBytes).toBeLessThan(3000);
    await svc.restoreBackup(id, b.name);
    expect(readFileSync(path.join(data, "gamefiles/big.bin"), "utf8")).toHaveLength(20_000);
    expect(readFileSync(path.join(data, "saved/world.sav"), "utf8")).toBe("save");
  });

  it("sets up a server from any image, with its ports used exactly as given", async () => {
    const id = await svc.deployCustom({
      name: "My Bedrock",
      image: "itzg/minecraft-bedrock-server:latest",
      ports: [{ port: 19132, protocol: "udp" }],
      env: { EULA: "TRUE", ADMIN_PASSWORD: "hunter22" },
      dataPath: "/data/",
      dataOwner: "1000:1000",
    });
    const c = [...docker.containers.values()][0];
    expect(c.spec.image).toBe("itzg/minecraft-bedrock-server:latest");
    expect(c.spec.env).toEqual({ EULA: "TRUE", ADMIN_PASSWORD: "hunter22" });
    expect(c.spec.ports).toEqual([{ port: 19132, protocol: "udp" }]);
    expect(c.spec.binds.map((b) => b.container)).toEqual(["/data"]);
    const [s] = await svc.list();
    expect(s).toMatchObject({ id, templateName: "Custom image", status: "online", secrets: ["ADMIN_PASSWORD"] });
    expect(svc.secret(id, "ADMIN_PASSWORD")).toBe("hunter22");
    // It survives a restart of the panel.
    const templates: unknown[] = [];
    const again = new ServerService({ ...(svc as unknown as { d: ConstructorParameters<typeof ServerService>[0] }).d, templates: templates as never });
    expect(again).toBeDefined();
    expect((templates as { id: string }[]).map((t) => t.id)).toEqual(["custom-my-bedrock"]);
  });

  it("does not shift a custom server's ports: a clash is reported instead", async () => {
    hostBusy.add("19132/udp");
    await expect(svc.deployCustom({ name: "B", image: "x/y", ports: [{ port: 19132, protocol: "udp" }] })).rejects.toMatchObject({ status: 409 });
    expect((svc as unknown as { d: { templates: { id: string }[] } }).d.templates.some((t) => t.id.startsWith("custom-"))).toBe(false);
  });

  it.each([
    [{ image: "bad image!" }, /Docker image name/],
    [{ ports: [] }, /at least one port/],
    [{ ports: [{ port: 80, protocol: "tcp" as const }] }, /not valid/],
    [{ ports: [{ port: 2000, protocol: "tcp" as const }, { port: 2000, protocol: "tcp" as const }] }, /twice/],
    [{ env: { "bad name": "x" } }, /not a valid setting name/],
    [{ dataPath: "../etc" }, /inside the container/],
    [{ dataPath: "//" }, /inside the container/],
    [{ dataOwner: "me" }, /1000:1000/],
  ])("rejects a custom server with a bad %j", async (bad, message) => {
    await expect(svc.deployCustom({ name: "C", image: "x/y", ports: [{ port: 2000, protocol: "tcp" }], ...bad })).rejects.toThrow(message);
  });

  it("forgets a custom image once its server is deleted with nothing left to restore", async () => {
    const templates = (svc as unknown as { d: { templates: { id: string }[] } }).d.templates;
    const id = await svc.deployCustom({ name: "Temp", image: "x/y", ports: [{ port: 2000, protocol: "tcp" }], dataPath: "/data" });
    await svc.remove(id); // data kept: the template stays so the server can be set up again
    expect(templates.some((t) => t.id === "custom-temp")).toBe(true);
    const id2 = await svc.deployCustom({ name: "Temp2", image: "x/y", ports: [{ port: 2001, protocol: "tcp" }] });
    await svc.remove(id2);
    expect(templates.some((t) => t.id === "custom-temp2")).toBe(false);
  });

  it("sets a deleted custom server up again from its backup on the same ports", async () => {
    const id = await svc.deployCustom({ name: "Bedrock", image: "x/y", ports: [{ port: 19132, protocol: "udp" }], dataPath: "/data" });
    writeFileSync(path.join(dir, "games", "bedrock", "level.dat"), "world");
    const b = await svc.backup(id);
    await svc.remove(id, { deleteData: true, confirmName: "Bedrock" });
    const again = await svc.deploy({ templateId: "custom-bedrock", name: "Bedrock 2", restoreFrom: { slug: "bedrock", name: b.name } });
    expect(readFileSync(path.join(dir, "games", "bedrock-2", "level.dat"), "utf8")).toBe("world");
    const [s] = await svc.list();
    expect(s.id).toBe(again);
    expect(s.ports).toEqual([{ name: "udp-19132", port: 19132, protocol: "udp" }]);
  });
});

describe("outside port check", () => {
  it("tests a public server's TCP ports from outside, using the public IP, and shows UDP as forwarded by the router", async () => {
    const mc = await svc.deploy({ templateId: "minecraft", name: "MC", env: { EULA: "TRUE" }, access: "public" });
    const pal = await deploy("Pal", { access: "public" });
    const r = await svc.checkReachability();
    expect(r.via).toBe("fake-checker");
    expect(probeCalls).toEqual([["203.0.113.7", 25565]]); // Palworld has only UDP ports: nothing to send outside
    expect(r.results.filter((i) => i.serverId === mc)).toEqual([expect.objectContaining({ port: 25565, protocol: "tcp", state: "open" })]);
    expect(r.results.filter((i) => i.serverId === pal).map((i) => [i.port, i.state])).toEqual([[8211, "forwarded"], [27015, "forwarded"]]);
    const list = await svc.list();
    expect(list.find((s) => s.id === mc)!.reachability).toMatchObject({ state: "ok", text: "Reachable from the internet" });
    expect(list.find((s) => s.id === pal)!.reachability).toMatchObject({ state: "forwarded" });
  });

  it("reports a closed port and a port the router is not forwarding as problems, never as open", async () => {
    const mc = await svc.deploy({ templateId: "minecraft", name: "MC", env: { EULA: "TRUE" }, access: "public" });
    probeAnswer = { state: "closed", detail: "Could not connect from any of 3 locations (Connection timed out)" };
    expect((await svc.checkReachability(mc)).results[0]).toMatchObject({ state: "closed" });
    expect((await svc.list())[0].reachability).toMatchObject({ state: "problem", text: "Port 25565 is not reachable from the internet" });
    const pal = await deploy("Pal", { access: "public" });
    net.open.clear(); // the router lost its rules
    const r = await svc.checkReachability(pal);
    expect(r.results.map((i) => i.state)).toEqual(["not-forwarded", "not-forwarded"]);
    expect((await svc.list()).find((s) => s.id === pal)!.reachability).toMatchObject({ state: "problem", text: "The router is not forwarding 8211/udp" });
  });

  it("keeps an unknown answer unknown", async () => {
    const mc = await svc.deploy({ templateId: "minecraft", name: "MC", env: { EULA: "TRUE" }, access: "public" });
    probeAnswer = { state: "unknown", detail: "Could not reach fake-checker: boom" };
    await svc.checkReachability(mc);
    expect((await svc.list())[0].reachability).toMatchObject({ state: "unknown", text: "Could not reach fake-checker: boom" });
  });

  it("keeps the last answer across a panel restart and dates it", async () => {
    const mc = await svc.deploy({ templateId: "minecraft", name: "MC", env: { EULA: "TRUE" }, access: "public" });
    await svc.checkReachability(mc);
    const restarted = new ServerService((svc as unknown as { d: ConstructorParameters<typeof ServerService>[0] }).d);
    const r = (await restarted.list())[0].reachability;
    expect(r).toMatchObject({ state: "ok", stale: null, attempt: null });
    expect(Date.now() - new Date(r!.at).getTime()).toBeLessThan(60_000);
  });

  it("marks an answer stale when the public IP changed or it is over a day old, and keeps showing it", async () => {
    const mc = await svc.deploy({ templateId: "minecraft", name: "MC", env: { EULA: "TRUE" }, access: "public" });
    await svc.checkReachability(mc);
    net.ip = "198.51.100.9";
    await svc.reconcile(); // the panel notices the new address
    expect((await svc.list())[0].reachability).toMatchObject({ state: "ok", stale: "ip-changed" });
    await svc.checkReachability(mc);
    expect((await svc.list())[0].reachability).toMatchObject({ state: "ok", stale: null });
    const db = (svc as unknown as { d: { db: ReturnType<typeof openDb>["db"] } }).d.db;
    const { portChecks } = await import("../src/server/db/schema.js");
    db.update(portChecks).set({ checkedAt: new Date(Date.now() - REACH_MAX_AGE_MS - 60_000) }).run();
    expect((await svc.list())[0].reachability).toMatchObject({ state: "ok", stale: "old" });
  });

  it("does not replace a saved answer with a check that could not finish", async () => {
    const mc = await svc.deploy({ templateId: "minecraft", name: "MC", env: { EULA: "TRUE" }, access: "public" });
    await svc.checkReachability(mc);
    probeAnswer = { state: "unknown", detail: "Could not reach fake-checker: boom" };
    await svc.checkReachability(mc);
    expect((await svc.list())[0].reachability).toMatchObject({ state: "ok", attempt: { text: "Could not reach fake-checker: boom" } });
    probeAnswer = { state: "closed", detail: "Could not connect from any of 3 locations" };
    await svc.checkReachability(mc);
    expect((await svc.list())[0].reachability).toMatchObject({ state: "problem", attempt: null });
  });

  it("goes back to untested when the ports or the access change", async () => {
    const mc = await svc.deploy({ templateId: "minecraft", name: "MC", env: { EULA: "TRUE" }, access: "public" });
    await svc.checkReachability(mc);
    await svc.changePorts(mc, 25570);
    expect((await svc.list())[0].reachability).toBeNull();
    await svc.checkReachability(mc);
    expect((await svc.list())[0].reachability).toMatchObject({ state: "ok" });
    await svc.setAccess(mc, "private");
    await svc.setAccess(mc, "public");
    expect((await svc.list())[0].reachability).toBeNull();
  });

  it("skips stopped servers, refuses private ones, and does nothing when there is nothing public", async () => {
    const mc = await svc.deploy({ templateId: "minecraft", name: "MC", env: { EULA: "TRUE" }, access: "public" });
    await svc.stop(mc);
    const r = await svc.checkReachability();
    expect(r.results).toEqual([expect.objectContaining({ state: "stopped" })]);
    expect(probeCalls).toEqual([]);
    expect((await svc.list())[0].reachability).toBeNull();
    const priv = await deploy("Quiet");
    await expect(svc.checkReachability(priv)).rejects.toMatchObject({ status: 409 });
    await expect(svc.checkReachability("nope")).rejects.toMatchObject({ status: 404 });
    await svc.remove(mc);
    await svc.remove(priv);
    expect((await svc.checkReachability()).results).toEqual([]);
  });

  it("explains when the public IP cannot be found, and when the check is turned off", async () => {
    await svc.deploy({ templateId: "minecraft", name: "MC", env: { EULA: "TRUE" }, access: "public" });
    net.missing = true;
    await expect(svc.checkReachability()).rejects.toMatchObject({ status: 502 });
    net.missing = false;
    (svc as unknown as { d: { portProbe: null } }).d.portProbe = null;
    await expect(svc.checkReachability()).rejects.toMatchObject({ status: 409 });
    expect(svc.portCheckInfo()).toEqual({ enabled: false, via: null });
  });
});

describe("daily restarts", () => {
  const at = (h: number, m: number, day = 3) => new Date(2026, 9, day, h, m, 0);
  const warnings = () => docker.execLog.filter((c) => c[1]?.startsWith("Broadcast")).map((c) => c[1]);
  const startsOf = (id: string) => docker.starts.get(svc.getRow(id)!.containerId!) ?? 0;
  const events = (id: string) => svc.events(id).map((e) => e.message);

  it("warns the players in the game, then restarts once at the chosen time, and again the next day", async () => {
    const id = await deploy();
    svc.setCare(id, { restart: { enabled: true, time: "04:00", warnMinutes: 5 } });
    const before = startsOf(id);
    expect(await svc.runScheduledCare(at(3, 50))).toEqual([]);
    await svc.runScheduledCare(at(3, 55));
    await svc.runScheduledCare(at(3, 55)); // the same minute is not announced twice
    await svc.runScheduledCare(at(3, 59));
    expect(warnings()).toEqual(["Broadcast Server_restarting_in_5_minutes.", "Broadcast Server_restarting_in_1_minute."]);
    expect(startsOf(id)).toBe(before);
    expect(await svc.runScheduledCare(at(4, 0))).toEqual(["our-palworld: restarted"]);
    expect(startsOf(id)).toBe(before + 1);
    expect(await svc.runScheduledCare(at(4, 1))).toEqual([]);
    expect(events(id)).toContain("Scheduled restart (daily at 04:00)");
    expect(await svc.runScheduledCare(at(4, 0, 4))).toEqual(["our-palworld: restarted"]);
  });

  it("restarts without a warning for a game that has no way to broadcast, and when no warning is wanted", async () => {
    const id = await svc.deploy({ templateId: "dragonwilds", name: "Dragons", env: { RSDW_OWNER_ID: "abc" } });
    svc.setCare(id, { restart: { enabled: true, time: "04:00", warnMinutes: 0 } });
    await svc.runScheduledCare(at(3, 55));
    await svc.runScheduledCare(at(3, 59));
    expect(warnings()).toEqual([]);
    expect(await svc.runScheduledCare(at(4, 0))).toHaveLength(1);
  });

  it("does not restart a stopped server, does not catch up after an hour, and leaves a server with no schedule alone", async () => {
    const stopped = await deploy("Stopped");
    svc.setCare(stopped, { restart: { enabled: true, time: "04:00", warnMinutes: 5 } });
    await svc.stop(stopped);
    expect(await svc.runScheduledCare(at(4, 0))).toEqual([]);
    expect(await svc.runScheduledCare(at(4, 1))).toEqual([]); // marked for today, so starting it later is not met with a restart
    const late = await deploy("Late");
    svc.setCare(late, { restart: { enabled: true, time: "04:00", warnMinutes: 5 } });
    expect(await svc.runScheduledCare(at(5, 30))).toEqual([]);
    expect(await svc.runScheduledCare(at(4, 20))).toEqual(["late: restarted"]); // within the hour: still runs
    const plain = await deploy("Plain");
    const n = startsOf(plain);
    await svc.runScheduledCare(at(4, 0));
    expect(startsOf(plain)).toBe(n);
  });

  it("checks the settings and keeps them across a read", async () => {
    const id = await deploy();
    expect(() => svc.setCare(id, { restart: { enabled: true, time: "25:00" } })).toThrow(UserError);
    expect(() => svc.setCare(id, { restart: { enabled: true, time: "04:00", warnMinutes: 7 } })).toThrow(/0, 1, 5, 10 or 15/);
    svc.setCare(id, { restart: { enabled: true, time: "03:30", warnMinutes: 10 }, update: { auto: true, time: "06:15" } });
    const info = (await svc.detail(id)).care;
    expect(info.settings).toEqual({ restart: { enabled: true, time: "03:30", warnMinutes: 10 }, update: { auto: true, time: "06:15" } });
    expect(info.canWarn).toBe(true);
    await svc.remove(id);
    await expect(svc.detail(id)).rejects.toBeInstanceOf(UserError);
  });
});

describe("updates", () => {
  const at = (h: number, m: number) => new Date(2026, 9, 3, h, m, 0);

  it("runs the pinned Palworld version and says when a newer version tag exists", async () => {
    const id = await deploy();
    expect([...docker.containers.values()][0].spec.image).toBe("thijsvanloef/palworld-server-docker:v2.8.0");
    const same = await svc.checkUpdate(id);
    expect(same).toMatchObject({ available: false, via: "tag", current: "v2.8.0" });
    expect((await svc.list())[0].update).toBeNull();
    hubTags = ["latest", "v2.8.0", "v2.9.1", "v2.9.0", "v2.9.1-wine", "dev"];
    const newer = await svc.checkUpdate(id);
    expect(newer).toMatchObject({ available: true, latest: "v2.9.1", note: "Version v2.9.1 is out. This server runs v2.8.0." });
    expect((await svc.list())[0].update).toEqual({ to: "v2.9.1" });
  });

  it("applies a newer version after a backup, recreates the container on it, and keeps the world", async () => {
    const id = await deploy();
    writeFileSync(path.join(dir, "games", "our-palworld", "world.sav"), "world");
    hubTags = ["v2.8.0", "v2.9.0"];
    await svc.checkUpdate(id);
    await svc.applyUpdate(id);
    expect(svc.listBackups(id)).toHaveLength(1);
    expect(docker.containers.size).toBe(1);
    const [c] = [...docker.containers.values()];
    expect(c.spec.image).toBe("thijsvanloef/palworld-server-docker:v2.9.0");
    expect(docker.pulled).toContain("thijsvanloef/palworld-server-docker:v2.9.0");
    expect(existsSync(path.join(dir, "games", "our-palworld", "world.sav"))).toBe(true);
    const [s] = await svc.list();
    expect(s.status).toBe("online");
    expect(s.update).toBeNull();
    expect((await svc.detail(id)).care.image).toMatchObject({ tag: "v2.9.0", moved: true });
    // a later settings change recreates the container on the same version, not the template's
    await svc.updateSettings(id, { env: { SERVER_NAME: "Renamed" } });
    expect([...docker.containers.values()][0].spec.image).toBe("thijsvanloef/palworld-server-docker:v2.9.0");
  });

  it("refuses to apply when no update was found, and explains a failed version look-up", async () => {
    const id = await deploy();
    await expect(svc.applyUpdate(id)).rejects.toMatchObject({ status: 409 });
    hubFails = true;
    await expect(svc.checkUpdate(id)).rejects.toMatchObject({ status: 502, message: expect.stringContaining("Docker Hub answered 503") });
  });

  it("for an image with no version tags, pulls it and compares builds", async () => {
    const id = await svc.deploy({ templateId: "minecraft", name: "MC", env: { EULA: "TRUE" } });
    expect(await svc.checkUpdate(id)).toMatchObject({ available: false, via: "image", note: expect.stringContaining("newest build") });
    docker.remote.set("itzg/minecraft-server:latest", "sha256:b2");
    expect(await svc.checkUpdate(id)).toMatchObject({ available: true, via: "image" });
    await svc.applyUpdate(id);
    expect(docker.containers.size).toBe(1);
    expect([...docker.containers.values()][0].imageId).toBe("sha256:b2");
    expect(await svc.checkUpdate(id)).toMatchObject({ available: false });
    docker.registryDown = true;
    await expect(svc.checkUpdate(id)).rejects.toMatchObject({ status: 502, message: expect.stringContaining("Could not reach the image registry") });
  });

  it("updates by itself at the chosen time, once a day, and only when there is something newer", async () => {
    const id = await svc.deploy({ templateId: "minecraft", name: "MC", env: { EULA: "TRUE" } });
    svc.setCare(id, { update: { auto: true, time: "05:00" } });
    expect(await svc.runScheduledCare(at(4, 59))).toEqual([]);
    expect(await svc.runScheduledCare(at(5, 0))).toEqual([]); // nothing newer
    docker.remote.set("itzg/minecraft-server:latest", "sha256:b2");
    expect(await svc.runScheduledCare(at(5, 1))).toEqual([]); // already looked today
    expect([...docker.containers.values()][0].imageId).toBe("sha256:a1");
    const next = new Date(2026, 9, 4, 5, 0, 0);
    expect(await svc.runScheduledCare(next)).toEqual(["mc: updated"]);
    expect([...docker.containers.values()][0].imageId).toBe("sha256:b2");
    expect(svc.events(id).map((e) => e.message).some((m) => m.startsWith("Updating to"))).toBe(true);
  });

  it("while a big download is under way, the server stays 'updating' and is not rebuilt behind its back", async () => {
    const id = await deploy();
    hubTags = ["v2.8.0", "v2.9.0"];
    await svc.checkUpdate(id);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const realPull = docker.pullImage.bind(docker);
    docker.pullImage = async (image: string) => {
      await gate;
      return realPull(image);
    };
    const job = svc.applyUpdate(id);
    // The backup runs before the status flips, and how long it takes varies by machine, so wait for the flip instead of a fixed delay.
    await vi.waitFor(async () => expect((await svc.list())[0].status).toBe("updating"), { timeout: 5000, interval: 10 });
    await svc.reconcile();
    expect(docker.containers.size).toBe(0); // reconcile did not start a second deploy
    release();
    await job;
    expect((await svc.list())[0].status).toBe("online");
    expect(docker.containers.size).toBe(1);
  });

  it("looks for a newer version tag by itself every few hours, without downloading anything", async () => {
    await deploy();
    const pulls = docker.pulled.length;
    hubTags = ["v2.8.0", "v2.9.0"];
    await svc.runScheduledCare(at(10, 0));
    expect((await svc.list())[0].update).toEqual({ to: "v2.9.0" });
    expect(docker.pulled.length).toBe(pulls);
    hubTags = ["v2.8.0", "v3.0.0"];
    await svc.runScheduledCare(at(10, 30)); // too soon to ask again
    expect((await svc.list())[0].update).toEqual({ to: "v2.9.0" });
    await svc.runScheduledCare(at(17, 0));
    expect((await svc.list())[0].update).toEqual({ to: "v3.0.0" });
  });
});

describe("changing a server's ports", () => {
  it("moves every port by the same amount, recreates the container, and keeps the world", async () => {
    const id = await deploy();
    writeFileSync(path.join(dir, "games", "our-palworld", "world.sav"), "world");
    const r = await svc.changePorts(id, 9000);
    expect(r).toEqual({ restarting: true });
    const [s] = await svc.list();
    expect(s.ports.map((p) => p.port)).toEqual([9000, 27015 + 789]);
    expect(s.status).toBe("online");
    const [c] = [...docker.containers.values()];
    expect(c.spec.env).toMatchObject({ PORT: "9000", QUERY_PORT: String(27015 + 789) });
    expect(c.spec.ports.map((p) => p.port)).toEqual([9000, 27804]);
    expect(existsSync(path.join(dir, "games", "our-palworld", "world.sav"))).toBe(true);
    expect(await svc.changePorts(id, 9000)).toEqual({ restarting: false });
  });

  it("closes the old router rules and opens the new ones for a public server", async () => {
    const id = await deploy("Pal", { access: "public" });
    expect([...net.open.keys()].sort()).toEqual(["27015/udp", "8211/udp"]);
    await svc.changePorts(id, 8300);
    expect([...net.open.keys()].sort()).toEqual(["27104/udp", "8300/udp"]);
    expect((await svc.list())[0].connect.public).toBe("pal.example.com:8300");
  });

  it("may reuse a port the server itself holds, but not one another server or the host is using", async () => {
    const id = await deploy("One");
    hostBusy = new Set(["8211/udp", "27015/udp"]); // the server's own sockets
    await svc.changePorts(id, 8212);
    expect((await svc.list())[0].ports.map((p) => p.port)).toEqual([8212, 27016]);
    const other = await deploy("Two");
    const kept = (await svc.list()).find((s) => s.id === other)!.ports;
    await expect(svc.changePorts(other, 8212)).rejects.toMatchObject({ status: 409, extra: { conflicts: ["8212/udp", "27016/udp"] } });
    hostBusy = new Set(["9100/udp"]);
    await expect(svc.changePorts(other, 9100)).rejects.toMatchObject({ status: 409 });
    await expect(svc.changePorts(other, 80)).rejects.toThrow(/not valid/);
    await expect(svc.changePorts(other, 65500)).rejects.toThrow(/not valid/);
    expect((await svc.list()).find((s) => s.id === other)!.ports).toEqual(kept);
  });

  it("refuses a custom image, whose ports the image decides", async () => {
    const id = await svc.deployCustom({ name: "Bedrock", image: "itzg/minecraft-bedrock-server:latest", ports: [{ port: 19132, protocol: "udp" }] });
    await expect(svc.changePorts(id, 20000)).rejects.toMatchObject({ status: 409 });
  });
});

describe("resource limits", () => {
  const MB = 1024 * 1024;
  const spec = () => [...docker.containers.values()][0].spec;

  it("starts with no limit unless asked", async () => {
    const id = await deploy();
    expect(spec().nanoCpus).toBeUndefined();
    expect(spec().memoryBytes).toBeUndefined();
    expect((await svc.list())[0].limits).toEqual({ cpus: null, memoryMb: null, warnings: [] });
    expect(id).toBeTruthy();
  });

  it("passes a CPU and memory cap from the deploy request to Docker", async () => {
    await deploy("Capped", { cpus: 1.5, memoryMb: 4096 });
    expect(spec().nanoCpus).toBe(1_500_000_000);
    expect(spec().memoryBytes).toBe(4096 * MB);
    expect((await svc.list())[0].limits).toMatchObject({ cpus: 1.5, memoryMb: 4096 });
  });

  it("rejects limits that Docker or common sense would not accept", async () => {
    await expect(deploy("A", { cpus: 0 })).rejects.toMatchObject({ status: 400, extra: { field: "cpus" } });
    await expect(deploy("A", { cpus: 9 })).rejects.toThrow(/8 CPU cores/);
    await expect(deploy("A", { cpus: "lots" })).rejects.toMatchObject({ extra: { field: "cpus" } });
    await expect(deploy("A", { memoryMb: 64 })).rejects.toMatchObject({ extra: { field: "memoryMb" } });
    expect(docker.containers.size).toBe(0);
    expect(await svc.list()).toHaveLength(0);
  });

  it("changing a limit recreates the container with it, keeps data and ports, and does not pull again", async () => {
    const id = await deploy("Alpha");
    const portsBefore = (await svc.list())[0].ports;
    expect(await svc.updateSettings(id, { cpus: 2, memoryMb: 2048 })).toEqual({ restarting: true });
    expect(docker.containers.size).toBe(1);
    expect(spec().nanoCpus).toBe(2_000_000_000);
    expect(spec().memoryBytes).toBe(2048 * MB);
    const s = (await svc.list())[0];
    expect(s.status).toBe("online");
    expect(s.ports).toEqual(portsBefore);
    expect(docker.pulled).toHaveLength(1);
    // A limit left out stays; null removes it.
    await svc.updateSettings(id, { memoryMb: null });
    expect(spec().memoryBytes).toBeUndefined();
    expect(spec().nanoCpus).toBe(2_000_000_000);
  });

  it("does not restart when the limits are sent but unchanged", async () => {
    const id = await deploy("Alpha", { memoryMb: 2048 });
    expect(await svc.updateSettings(id, { memoryMb: 2048, cpus: null })).toEqual({ restarting: false });
  });

  it("keeps the old limits when a new one is rejected", async () => {
    const id = await deploy("Alpha", { cpus: 1 });
    await expect(svc.updateSettings(id, { cpus: 99 })).rejects.toThrow(/CPU cores/);
    expect((await svc.list())[0].limits.cpus).toBe(1);
  });

  it("applies the limits again when a missing container is recreated", async () => {
    await deploy("Alpha", { cpus: 1, memoryMb: 1024 });
    docker.containers.clear();
    await svc.reconcile();
    expect(spec().nanoCpus).toBe(1_000_000_000);
    expect(spec().memoryBytes).toBe(1024 * MB);
  });

  it("warns, but allows it, when the memory cap is below what the game needs", async () => {
    const id = await svc.deploy({ templateId: "satisfactory", name: "Factory", memoryMb: 4096 });
    const [s] = await svc.list();
    expect(s.limits.warnings).toEqual([expect.stringMatching(/needs about 8 GB.*4 GB limit/)]);
    expect(svc.events(id).some((e) => e.level === "warn" && /8 GB/.test(e.message))).toBe(true);
    expect((await svc.detail(id)).minMemoryMb).toBe(8192);
    await svc.updateSettings(id, { memoryMb: 8192 });
    expect((await svc.list())[0].limits.warnings).toEqual([]);
  });

  it("takes limits for a custom image too", async () => {
    await svc.deployCustom({ name: "Mine", image: "someone/game:latest", ports: [{ port: 19132, protocol: "udp" }], cpus: 1, memoryMb: 512 });
    expect(spec().nanoCpus).toBe(1_000_000_000);
    expect(spec().memoryBytes).toBe(512 * MB);
  });
});
