import { beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/server/config.js";
import { openDb, schema } from "../src/server/db/index.js";
import { decrypt } from "../src/server/dns/settings.js";
import { PlayitClient, parseRundata, type FetchFn } from "../src/server/relay/playit.js";
import { FREE_TUNNELS, PLAYIT_IMAGE, planTunnels, RelayManager } from "../src/server/relay/manager.js";
import { buildApp } from "../src/server/app.js";
import { DnsSettings } from "../src/server/dns/settings.js";
import { Notifier } from "../src/server/notifications/notifier.js";
import { ServerService } from "../src/server/servers/service.js";
import { loadTemplates } from "../src/server/templates/loader.js";
import type { TcpProbe } from "../src/server/reachability.js";
import { FakeConnectivity, FakeDns, FakeDocker } from "./helpers/fakes.js";

const SECRET = "agent-secret-key-0123456789";

/** A pretend playit.gg: one agent, a list of tunnels, and switches for the answers the real service might give. */
class FakePlayit {
  tunnels: { id: string; name: string; port_type: string; local_port: number; local_ip: string }[] = [];
  calls: { path: string; body: Record<string, unknown>; auth: string }[] = [];
  refuseCreate = false;
  down = false;
  private n = 0;

  fetch: FetchFn = async (url, init) => {
    if (this.down) throw new Error("offline");
    const p = url.replace("https://api.playit.gg", "");
    const body = JSON.parse(init.body) as Record<string, unknown>;
    this.calls.push({ path: p, body, auth: init.headers.authorization });
    const reply = (json: unknown) => ({ ok: true, status: 200, json: async () => json });
    if (init.headers.authorization !== `Agent-Key ${SECRET}`) return reply({ status: "error", data: { type: "auth", message: "InvalidAgentKey" } });
    if (p === "/agents/rundata") {
      return reply({
        status: "success",
        data: {
          agent_id: "agent-1",
          account_status: "verified",
          tunnels: this.tunnels.map((t, i) => ({ id: t.id, name: t.name, proto: t.port_type, port: { from: 20000 + i, to: 20000 + i }, assigned_domain: `t${i}.gl.at.ply.gg`, local_ip: t.local_ip, local_port: t.local_port })),
        },
      });
    }
    if (p === "/tunnels/create") {
      if (this.refuseCreate) return reply({ status: "fail", data: "NotAllowedWithReadOnly" });
      const origin = (body.origin as { data: { local_ip: string; local_port: number } }).data;
      const id = `tun-${++this.n}`;
      this.tunnels.push({ id, name: body.name as string, port_type: body.port_type as string, local_port: origin.local_port, local_ip: origin.local_ip });
      return reply({ status: "success", data: { id } });
    }
    if (p === "/tunnels/delete") {
      this.tunnels = this.tunnels.filter((t) => t.id !== body.tunnel_id);
      return reply({ status: "success", data: {} });
    }
    return reply({ status: "fail", data: "Unknown" });
  };
}

describe("parseRundata", () => {
  it("reads the agent shape: domain plus the first public port", () => {
    const r = parseRundata({ agent_id: "a1", account_status: "verified", tunnels: [{ id: "t1", name: "gl-x-8211", proto: "udp", port: { from: 4242, to: 4242 }, assigned_domain: "abc.gl.at.ply.gg", local_ip: "127.0.0.1", local_port: 8211 }] });
    expect(r).toEqual({ agentId: "a1", accountStatus: "verified", tunnels: [{ id: "t1", name: "gl-x-8211", proto: "udp", address: "abc.gl.at.ply.gg:4242", localPort: 8211, disabled: false }] });
  });

  it("prefers a custom domain, and reads the newer display_address shape", () => {
    const r = parseRundata({ tunnels: [{ id: "t1", port: { from: 1, to: 1 }, assigned_domain: "a.ply.gg", custom_domain: "play.me.com" }, { id: "t2", display_address: "x.joinmc.link", port_type: "tcp", disabled_reason: "plan" }] });
    expect(r.tunnels[0].address).toBe("play.me.com:1");
    expect(r.tunnels[1]).toMatchObject({ address: "x.joinmc.link", proto: "tcp", disabled: true });
  });

  it("copes with missing or odd fields instead of throwing", () => {
    expect(parseRundata(null)).toEqual({ agentId: null, accountStatus: null, tunnels: [] });
    expect(parseRundata({ tunnels: [7, { name: "no id" }, { id: "t", port: "x" }] }).tunnels).toEqual([{ id: "t", name: null, proto: null, address: null, localPort: null, disabled: false }]);
  });
});

describe("PlayitClient", () => {
  it("sends the key only in the Authorization header", async () => {
    const fake = new FakePlayit();
    await new PlayitClient(SECRET, fake.fetch).rundata();
    expect(fake.calls[0].path).toBe("/agents/rundata");
    expect(fake.calls[0].auth).toBe(`Agent-Key ${SECRET}`);
    expect(JSON.stringify(fake.calls[0].body)).not.toContain(SECRET);
  });

  it("explains a bad key without repeating it", async () => {
    const fake = new FakePlayit();
    const err = (await new PlayitClient("wrong-key-value", fake.fetch).rundata().catch((e: unknown) => e)) as Error & { kind: string };
    expect(err.kind).toBe("auth");
    expect(err.message).toBe("playit.gg does not accept that secret key");
    expect(err.message).not.toContain("wrong-key-value");
  });

  it("reports a network failure as such", async () => {
    const fake = new FakePlayit();
    fake.down = true;
    await expect(new PlayitClient(SECRET, fake.fetch).rundata()).rejects.toMatchObject({ kind: "network" });
  });

  it("creates a tunnel with the agent as origin", async () => {
    const fake = new FakePlayit();
    const id = await new PlayitClient(SECRET, fake.fetch).createTunnel({ agentId: "agent-1", name: "gl-x-8211", proto: "udp", localIp: "192.168.1.20", localPort: 8211 });
    expect(id).toBe("tun-1");
    expect(fake.calls[0].body).toMatchObject({ name: "gl-x-8211", port_type: "udp", port_count: 1, enabled: true, origin: { type: "agent", data: { agent_id: "agent-1", local_ip: "192.168.1.20", local_port: 8211 } } });
  });
});

describe("planTunnels", () => {
  it("makes one tunnel per host port and merges tcp+udp on the same port", () => {
    expect(
      planTunnels("sat", [
        { port: 7777, protocol: "udp" },
        { port: 7777, protocol: "tcp" },
        { port: 8888, protocol: "tcp" },
      ]),
    ).toEqual([
      { name: "gl-sat-7777", port: 7777, protocol: "both" },
      { name: "gl-sat-8888", port: 8888, protocol: "tcp" },
    ]);
  });
});

describe("RelayManager", () => {
  let fake: FakePlayit;
  let docker: FakeDocker;
  let db: ReturnType<typeof openDb>["db"];
  let mgr: RelayManager;
  const config = loadConfig({ SESSION_SECRET: "s".repeat(40), DATA_DIR: "/tmp/x", HOST_LAN_IP: "192.168.1.20" });
  const server = { id: "s1", slug: "our-palworld", ports: [{ port: 8211, protocol: "udp" as const }] };

  beforeEach(() => {
    fake = new FakePlayit();
    docker = new FakeDocker();
    db = openDb(":memory:").db;
    mgr = new RelayManager(db, config, docker, (s) => new PlayitClient(s, fake.fetch));
  });

  it("is not configured at first and refuses to enable", async () => {
    expect(mgr.configured()).toBe(false);
    await expect(mgr.enable(server)).rejects.toMatchObject({ status: 409 });
  });

  it("checks the key before saving it, stores it encrypted and never reports it", async () => {
    await expect(mgr.save({ secret: "wrong", mode: "existing" })).rejects.toThrow(/does not accept/);
    expect(mgr.configured()).toBe(false);

    await mgr.save({ secret: SECRET, mode: "existing" });
    const stored = db.select().from(schema.settings).all().find((r) => r.key === "relay_playit_secret")!.value;
    expect(stored).not.toContain(SECRET);
    expect(decrypt(stored, config.SESSION_SECRET)).toBe(SECRET);
    expect(JSON.stringify(await mgr.status())).not.toContain(SECRET);

    // a blank key on a later save keeps the saved one
    await mgr.save({ mode: "existing", localHost: "10.0.0.5" });
    expect(mgr.localHost()).toBe("10.0.0.5");
    expect(mgr.configured()).toBe(true);
  });

  it("with an existing agent: creates tunnels pointing at this machine and reads the address back", async () => {
    await mgr.save({ secret: SECRET, mode: "existing" });
    await mgr.enable(server);
    expect(fake.tunnels).toEqual([{ id: "tun-1", name: "gl-our-palworld-8211", port_type: "udp", local_port: 8211, local_ip: "192.168.1.20" }]);
    expect(docker.containers.size).toBe(0); // the panel does not run an agent here
    expect(mgr.info(server)).toMatchObject({ state: "ready", address: "t0.gl.at.ply.gg:20000" });
  });

  it("does not create a tunnel twice, and adopts a hand-made one on the same local port", async () => {
    await mgr.save({ secret: SECRET, mode: "existing" });
    fake.tunnels.push({ id: "mine", name: "palworld", port_type: "udp", local_port: 8211, local_ip: "192.168.1.20" });
    await mgr.enable(server);
    await mgr.enable(server);
    expect(fake.tunnels).toHaveLength(1);
    expect(mgr.info(server)).toMatchObject({ state: "ready", address: "t0.gl.at.ply.gg:20000" });
  });

  it("falls back to guided setup when playit.gg refuses to create tunnels", async () => {
    await mgr.save({ secret: SECRET, mode: "existing" });
    fake.refuseCreate = true;
    await mgr.enable(server);
    const info = mgr.info(server);
    expect(info.state).toBe("setup");
    expect(info.tunnels).toEqual([{ name: "gl-our-palworld-8211", port: 8211, protocol: "udp", local: "192.168.1.20:8211", address: null }]);
    expect(info.problem).toMatch(/add them once by hand in the playit.gg dashboard/);
    expect(info.fix).toBe("tunnels");
    // once the person adds it by hand, the next refresh picks the address up
    fake.tunnels.push({ id: "hand", name: "gl-our-palworld-8211", port_type: "udp", local_port: 8211, local_ip: "192.168.1.20" });
    await mgr.refresh();
    expect(mgr.info(server)).toMatchObject({ state: "ready", fix: null, address: "t0.gl.at.ply.gg:20000" });
  });

  it("points at Settings when there is no key or no agent address, and at the tunnels while they are missing", async () => {
    expect(mgr.info(server)).toMatchObject({ state: "error", fix: "settings" });
    await mgr.save({ secret: SECRET, mode: "existing" });
    fake.refuseCreate = true;
    await mgr.enable(server);
    expect(mgr.info(server).fix).toBe("tunnels");
    const bare = new RelayManager(db, loadConfig({ SESSION_SECRET: "s".repeat(40), DATA_DIR: "/tmp/x" }), docker, (s) => new PlayitClient(s, fake.fetch));
    db.delete(schema.settings).run();
    await bare.save({ secret: SECRET, mode: "existing" });
    expect(bare.info(server)).toMatchObject({ state: "error", fix: "settings" });
  });

  it("uses a tunnel made by hand with the exact name, whatever type it was given", async () => {
    await mgr.save({ secret: SECRET, mode: "existing" });
    fake.refuseCreate = true;
    await mgr.enable(server);
    fake.tunnels.push({ id: "hand", name: "gl-our-palworld-8211", port_type: "tcp", local_port: 1, local_ip: "127.0.0.1" });
    await mgr.refresh();
    expect(mgr.info(server)).toMatchObject({ state: "ready", address: "t0.gl.at.ply.gg:20000" });
  });

  describe("the agent's address for this machine", () => {
    it("explains why 127.0.0.1 only suits an agent on the same network, and suggests the home network address", async () => {
      await mgr.save({ secret: SECRET, mode: "existing", localHost: "127.0.0.1" });
      fake.refuseCreate = true;
      await mgr.enable(server);
      const note = mgr.info(server).localNote;
      expect(note).toMatch(/own Docker container/);
      expect(note).toContain("192.168.1.20");
      expect((await mgr.status()).localNote).toBe(note);
      expect((await mgr.status()).lanIp).toBe("192.168.1.20");
    });

    it("also flags Docker's internal 172.17.x.x addresses, but not a normal home network address", async () => {
      await mgr.save({ secret: SECRET, mode: "existing", localHost: "172.17.0.1" });
      fake.refuseCreate = true;
      await mgr.enable(server);
      expect(mgr.info(server).localNote).toMatch(/own Docker container/);
      await mgr.save({ mode: "existing", localHost: "192.168.68.61" });
      expect(mgr.info(server).localNote).toBeNull();
    });

    it("defaults to the host's home network address and says nothing about it", async () => {
      await mgr.save({ secret: SECRET, mode: "existing" });
      expect(mgr.localHost()).toBe("192.168.1.20");
      expect((await mgr.status()).localNote).toBeNull();
    });
  });

  describe("noticing tunnels added by hand", () => {
    it("re-reads playit.gg when what it knows is old, and only once at a time", async () => {
      await mgr.save({ secret: SECRET, mode: "existing" });
      fake.refuseCreate = true;
      await mgr.enable(server);
      fake.tunnels.push({ id: "hand", name: "gl-our-palworld-8211", port_type: "udp", local_port: 8211, local_ip: "192.168.1.20" });
      const before = fake.calls.length;
      mgr.refreshSoon(0);
      mgr.refreshSoon(0); // one is already on its way
      await new Promise((r) => setTimeout(r, 20));
      expect(fake.calls.length - before).toBe(1);
      expect(mgr.info(server).state).toBe("ready");
    });

    it("leaves a fresh answer alone, and does nothing without a key", async () => {
      const idle = fake.calls.length;
      mgr.refreshSoon(0);
      expect(fake.calls.length).toBe(idle);
      await mgr.save({ secret: SECRET, mode: "existing" });
      await mgr.refresh();
      const before = fake.calls.length;
      mgr.refreshSoon(60_000);
      await new Promise((r) => setTimeout(r, 20));
      expect(fake.calls.length).toBe(before);
    });
  });

  it("needs somewhere for the agent to reach this machine", async () => {
    const bare = new RelayManager(db, loadConfig({ SESSION_SECRET: "s".repeat(40), DATA_DIR: "/tmp/x" }), docker, (s) => new PlayitClient(s, fake.fetch));
    await bare.save({ secret: SECRET, mode: "existing" });
    await expect(bare.enable(server)).rejects.toThrow(/which address/);
  });

  it("managed mode runs the agent without privileges, on the host network, and removes it with the last server", async () => {
    await mgr.save({ secret: SECRET, mode: "managed" });
    await mgr.enable(server);
    const [c] = [...docker.containers.values()];
    expect(c.spec.name).toMatch(/^gl-(.+-)?playit$/);
    expect(c.spec.image).toBe(PLAYIT_IMAGE);
    expect(c.spec.networkMode).toBe("host");
    expect(c.spec.env).toEqual({ SECRET_KEY: SECRET });
    expect(c.spec).not.toHaveProperty("privileged");
    expect(c.state).toBe("running");
    expect(fake.tunnels[0].local_ip).toBe("127.0.0.1");

    await mgr.disable(server, 0);
    expect(fake.tunnels).toHaveLength(0); // the panel's own tunnels go
    expect(docker.containers.size).toBe(0);
  });

  it("leaves tunnels it did not create alone when a server leaves the relay", async () => {
    await mgr.save({ secret: SECRET, mode: "existing" });
    fake.tunnels.push({ id: "hand", name: "gl-our-palworld-8211", port_type: "udp", local_port: 8211, local_ip: "192.168.1.20" });
    await mgr.enable(server);
    await mgr.disable(server, 0);
    expect(fake.tunnels.map((t) => t.id)).toEqual(["hand"]);
  });

  it("warns when the servers would need more tunnels than the free plan has", async () => {
    await mgr.save({ secret: SECRET, mode: "existing" });
    db.insert(schema.servers).values({ id: "s9", slug: "big", name: "Big", templateId: "x", access: "relay", createdAt: new Date() }).run();
    for (let i = 0; i <= FREE_TUNNELS; i++) db.insert(schema.serverPorts).values({ serverId: "s9", name: `p${i}`, port: 3000 + i, protocol: "udp" }).run();
    const st = await mgr.status();
    expect(st.needs).toEqual({ tcp: 0, udp: FREE_TUNNELS + 1, limit: FREE_TUNNELS });
    expect(st.warning).toMatch(/free playit.gg plan/);
  });

  it("forgets the key and removes the agent on clear", async () => {
    await mgr.save({ secret: SECRET, mode: "managed" });
    await mgr.enable(server);
    expect(docker.containers.size).toBe(1);
    await mgr.clear();
    expect(mgr.configured()).toBe(false);
    expect(docker.containers.size).toBe(0);
  });
});

describe("access through the relay", () => {
  let fake: FakePlayit;
  let net: FakeConnectivity;
  let dns: FakeDns;
  let svc: ServerService;
  let relay: RelayManager;

  beforeEach(() => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "gl-relay-"));
    const config = loadConfig({ SESSION_SECRET: "x".repeat(32), DATA_DIR: dir, GAMESERVERS_DIR: path.join(dir, "games").replace(/^[A-Za-z]:/, "").replaceAll("\\", "/"), HOST_LAN_IP: "192.168.1.50", PUBLIC_HOST: "play.example.com", CF_ZONE: "example.com" });
    const db = openDb(":memory:").db;
    const docker = new FakeDocker();
    const probe: TcpProbe = { name: "fake-checker", check: async () => ({ state: "open", detail: "Connected from 3 of 3 locations" }) };
    fake = new FakePlayit();
    net = new FakeConnectivity();
    dns = new FakeDns();
    relay = new RelayManager(db, config, docker, (s) => new PlayitClient(s, fake.fetch));
    svc = new ServerService({ config, db, templates: loadTemplates(path.resolve("templates")), docker, connectivity: net, dns, relay, hostPorts: () => new Set(), background: false, stableMs: 0, portProbe: probe, tagLister: async () => [], queryPlayers: async () => null, hostCores: 8 });
  });

  const deploy = (name = "Our Palworld", extra: object = {}) => svc.deploy({ templateId: "palworld", name, ...extra });

  it("is refused with a clear reason until the key is saved, and the server keeps its old access", async () => {
    const id = await deploy();
    await svc.setAccess(id, "public");
    await expect(svc.setAccess(id, "relay")).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/secret key/) });
    expect((await svc.list())[0].access).toBe("public");
    expect(net.open.size).toBe(2);
  });

  it("closes the router rules and the DNS record, shows the relay address, and keeps the LAN one", async () => {
    await relay.save({ secret: SECRET, mode: "existing" });
    const id = await deploy();
    await svc.setAccess(id, "public");
    expect(net.open.size).toBe(2);
    expect(dns.cnames.get("our-palworld")).toBe("play.example.com");
    await svc.setAccess(id, "relay");
    expect(net.open.size).toBe(0);
    expect(dns.cnames.size).toBe(0);
    const [s] = await svc.list();
    expect(s.access).toBe("relay");
    expect(s.connect.public).toBeNull();
    expect(s.connect.relay).toBe("t0.gl.at.ply.gg:20000");
    expect(s.connect.lan).toBe("192.168.1.50:8211");
    expect(s.relay?.tunnels.map((t) => t.name)).toEqual(["gl-our-palworld-8211", "gl-our-palworld-27015"]);
    expect(s.reachability).toBeNull();
  });

  it("is a separate path: public still opens the router and the DNS record and uses no tunnels", async () => {
    await relay.save({ secret: SECRET, mode: "existing" });
    const id = await deploy();
    await svc.setAccess(id, "public");
    expect(net.open.size).toBe(2);
    expect(dns.cnames.get("our-palworld")).toBe("play.example.com");
    expect(fake.tunnels).toHaveLength(0);
  });

  it("removes its tunnels when the server goes back to private or is deleted", async () => {
    await relay.save({ secret: SECRET, mode: "existing" });
    const id = await deploy();
    await svc.setAccess(id, "relay");
    expect(fake.tunnels).toHaveLength(2);
    await svc.setAccess(id, "private");
    expect(fake.tunnels).toHaveLength(0);

    await svc.setAccess(id, "relay");
    expect(fake.tunnels).toHaveLength(2);
    await svc.remove(id);
    expect(fake.tunnels).toHaveLength(0);
  });

  it("can be chosen when the server is first deployed", async () => {
    await relay.save({ secret: SECRET, mode: "existing" });
    await deploy("Friends", { access: "relay" });
    const [s] = await svc.list();
    expect(s.access).toBe("relay");
    expect(s.connect.relay).toBe("t0.gl.at.ply.gg:20000");
  });

  it("keeps a server named playit from taking the agent's container name", async () => {
    await deploy("Playit");
    const [s] = await svc.list();
    expect(s.slug).not.toBe("playit");
  });
});

describe("relay settings api", () => {
  it("needs a login, checks the key, and never sends the key back", async () => {
    const games = mkdtempSync(path.join(os.tmpdir(), "gl-relay-api-")).replace(/^[A-Za-z]:/, "").replaceAll("\\", "/");
    const config = loadConfig({ SESSION_SECRET: "x".repeat(32), DATA_DIR: "/tmp/unused", GAMESERVERS_DIR: games, HOST_LAN_IP: "192.168.1.50" });
    const { db } = openDb(":memory:");
    const docker = new FakeDocker();
    const fake = new FakePlayit();
    const relay = new RelayManager(db, config, docker, (s) => new PlayitClient(s, fake.fetch));
    const templates = loadTemplates(path.resolve("templates"));
    const service = new ServerService({ config, db, templates, docker, connectivity: new FakeConnectivity(), hostPorts: () => new Set(), background: false, stableMs: 0, relay });
    const app = buildApp({ config, db, templates, service, docker, dnsSettings: new DnsSettings(db, config), notifier: new Notifier(db, config), relay });

    expect((await app.inject("/api/settings/relay")).statusCode).toBe(401);
    const setup = await app.inject({ method: "POST", url: "/api/auth/setup", payload: { password: "correct horse battery" } });
    const headers = { cookie: String(([] as string[]).concat(setup.headers["set-cookie"] as string)[0]).split(";")[0] };

    const bad = await app.inject({ method: "PUT", url: "/api/settings/relay", headers, payload: { secret: "nope", mode: "existing" } });
    expect(bad.statusCode).toBe(400);
    expect(bad.body).not.toContain("nope");

    const ok = await app.inject({ method: "PUT", url: "/api/settings/relay", headers, payload: { secret: SECRET, mode: "existing" } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ configured: true, mode: "existing" });
    expect(ok.body).not.toContain(SECRET);
    expect((await app.inject({ url: "/api/settings/relay", headers })).body).not.toContain(SECRET);

    expect((await app.inject({ method: "DELETE", url: "/api/settings/relay", headers })).statusCode).toBe(200);
    expect((await app.inject({ url: "/api/settings/relay", headers })).json()).toMatchObject({ configured: false });
  });
});
