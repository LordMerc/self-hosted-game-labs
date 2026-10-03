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
