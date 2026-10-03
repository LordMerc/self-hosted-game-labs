import { beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/server/config.js";
import { openDb } from "../src/server/db/index.js";
import { ServerService, UserError } from "../src/server/servers/service.js";
import { loadTemplates } from "../src/server/templates/loader.js";
import { FakeConnectivity, FakeDns, FakeDocker } from "./helpers/fakes.js";

let docker: FakeDocker;
let net: FakeConnectivity;
let dns: FakeDns;
let svc: ServerService;
let dir: string;
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

describe("usage", () => {
  it("reports CPU and memory for running servers only, and skips one whose stats fail", async () => {
    const a = await deploy("Alpha");
    const b = await deploy("Bravo");
    await svc.stop(b);
    expect(Object.keys(await svc.usage())).toEqual([a]);
    docker.usage = async () => {
      throw new Error("docker busy");
    };
    expect(await svc.usage()).toEqual({});
  });
});
