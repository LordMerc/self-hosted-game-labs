import { eq } from "drizzle-orm";
import type { Config } from "../config.js";
import type { Db } from "../db/index.js";
import { schema } from "../db/index.js";
import { decrypt, encrypt } from "../dns/settings.js";
import type { ContainerDriver } from "../docker/driver.js";
import { LABEL_MANAGED, LABEL_RELAY } from "../docker/driver.js";
import { names } from "../instance.js";
import { PlayitClient, PlayitError, type PlayitRundata, type TunnelProto } from "./playit.js";

/** Pinned on purpose: an upstream release must not change what the panel runs. Checked against ghcr.io on 2026-10-03 (docs/relay-playit.md). */
export const PLAYIT_IMAGE = "ghcr.io/playit-cloud/playit-agent:1.0.10";
/** playit.gg's free plan, from secondary sources (docs/relay-playit.md): about this many tunnels of each kind. */
export const FREE_TUNNELS = 4;
/** The server slug the agent container's name takes; no game server may use it. */
export const RELAY_SLUG = "playit";

const K_SECRET = "relay_playit_secret";
const K_MODE = "relay_playit_mode";
const K_LOCAL = "relay_playit_local_host";
const K_CREATED = "relay_playit_created";
const K_CONTAINER = "relay_playit_container";

/** `existing`: the person already runs a playit agent (the usual case); `managed`: the panel runs one for them. */
export type RelayMode = "existing" | "managed";

export interface RelayStatus {
  configured: boolean;
  mode: RelayMode;
  /** Where the agent should send traffic to reach this machine (existing agent only). */
  localHost: string | null;
  /** Free-plan tunnels the servers in relay mode need, against what the plan allows. */
  needs: { tcp: number; udp: number; limit: number };
  warning: string | null;
  agent: { state: "running" | "stopped" | "missing" | "external"; problem: string | null };
  account: { checkedAt: string | null; tunnels: number | null; status: string | null; problem: string | null };
}

export interface RelayTunnelInfo {
  name: string;
  port: number;
  protocol: TunnelProto;
  /** Where the agent has to send this tunnel's traffic. */
  local: string;
  /** What players type; null until playit.gg has the tunnel and the panel has read it back. */
  address: string | null;
}

export interface RelayInfo {
  /** `ready`: every tunnel has an address. `setup`: tunnels are missing (create them by hand). `error`: playit.gg could not be asked. */
  state: "ready" | "setup" | "error";
  /** The address to give players: the first (game) port's. */
  address: string | null;
  tunnels: RelayTunnelInfo[];
  problem: string | null;
}

export interface RelayServer {
  id: string;
  slug: string;
  ports: { port: number; protocol: "tcp" | "udp" }[];
}

export class RelayError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
  ) {
    super(message);
  }
}

/** One tunnel per host port: a port used for both TCP and UDP shares one `both` tunnel, which keeps a server inside the free plan. */
export function planTunnels(slug: string, ports: RelayServer["ports"]): { name: string; port: number; protocol: TunnelProto }[] {
  const byPort = new Map<number, Set<string>>();
  for (const p of ports) byPort.set(p.port, (byPort.get(p.port) ?? new Set()).add(p.protocol));
  return [...byPort.entries()].map(([port, protos]) => ({ name: `gl-${slug}-${port}`, port, protocol: protos.size === 2 ? "both" : (protos.has("tcp") ? "tcp" : "udp") }));
}

/**
 * Hide-my-IP relay through playit.gg. The panel keeps the (encrypted) secret key, optionally runs the agent, works out which
 * tunnels each relay server needs, asks playit.gg to create them (best effort) and reads the public address back.
 */
export class RelayManager {
  private cache: { at: number; data: PlayitRundata | null; error: string | null } | null = null;
  /** The create call is unverified for agent keys; once playit.gg refuses it the panel stops trying until the settings change. */
  private createRefused: string | null = null;

  constructor(
    private readonly db: Db,
    private readonly config: Config,
    private readonly docker: ContainerDriver,
    private readonly makeClient: (secret: string) => PlayitClient = (s) => new PlayitClient(s),
  ) {}

  // ---------------------------------------------------------------- settings

  private get(key: string): string | null {
    return this.db.select().from(schema.settings).where(eq(schema.settings.key, key)).get()?.value ?? null;
  }
  private set(key: string, value: string) {
    this.db.insert(schema.settings).values({ key, value }).onConflictDoUpdate({ target: schema.settings.key, set: { value } }).run();
  }
  private del(key: string) {
    this.db.delete(schema.settings).where(eq(schema.settings.key, key)).run();
  }

  private secret(): string | null {
    const enc = this.get(K_SECRET);
    return enc ? decrypt(enc, this.config.SESSION_SECRET) : null;
  }

  configured(): boolean {
    return this.secret() !== null;
  }

  mode(): RelayMode {
    return this.get(K_MODE) === "managed" ? "managed" : "existing";
  }

  /** In managed mode the agent shares the host's network; an existing agent is reached at the address saved here, or this machine's LAN address. */
  localHost(): string | null {
    if (this.mode() === "managed") return "127.0.0.1";
    return this.get(K_LOCAL) ?? this.config.HOST_LAN_IP ?? null;
  }

  private relayServers(): RelayServer[] {
    const rows = this.db.select().from(schema.servers).where(eq(schema.servers.access, "relay")).all();
    return rows.map((r) => ({ id: r.id, slug: r.slug, ports: this.db.select().from(schema.serverPorts).where(eq(schema.serverPorts.serverId, r.id)).all().map((p) => ({ port: p.port, protocol: p.protocol })) }));
  }

  /** Save from the Settings page after checking the key with playit.gg. A blank key keeps the saved one. Never returns or logs the key. */
  async save(input: { secret?: string; mode: RelayMode; localHost?: string }): Promise<void> {
    const secret = input.secret?.trim() || this.secret();
    if (!secret) throw new RelayError("Paste the secret key of your playit.gg agent");
    const localHost = input.localHost?.trim() ?? "";
    if (localHost && !/^[A-Za-z0-9._:-]{1,253}$/.test(localHost)) throw new RelayError("The agent's address for this machine should be an IP address or host name");
    try {
      await this.makeClient(secret).rundata();
    } catch (e) {
      throw new RelayError(e instanceof PlayitError ? e.message : "Could not check the key with playit.gg", e instanceof PlayitError && e.kind === "network" ? 502 : 400);
    }
    this.set(K_SECRET, encrypt(secret, this.config.SESSION_SECRET));
    this.set(K_MODE, input.mode);
    if (localHost) this.set(K_LOCAL, localHost);
    else this.del(K_LOCAL);
    this.cache = null;
    this.createRefused = null;
    await this.reconfigure();
  }

  /** Forget the key and tidy up. Servers still set to relay keep that setting but show that setup is needed. */
  async clear(): Promise<void> {
    for (const k of [K_SECRET, K_MODE, K_LOCAL, K_CREATED]) this.del(k);
    this.cache = null;
    this.createRefused = null;
    await this.removeAgent();
    this.del(K_CONTAINER);
  }

  // ---------------------------------------------------------------- agent container (managed mode)

  /** Make the running agent match the saved settings: started while a server uses the relay (managed mode), gone otherwise. */
  async reconfigure(): Promise<void> {
    if (this.mode() === "managed" && this.configured() && this.relayServers().length > 0) await this.ensureAgent();
    else await this.removeAgent();
  }

  private async ensureAgent(): Promise<void> {
    const secret = this.secret();
    if (!secret) return;
    try {
      await this.docker.pullImage(PLAYIT_IMAGE);
    } catch (e) {
      if (!(await this.docker.imageId(PLAYIT_IMAGE))) throw new RelayError(`Could not download the playit.gg agent: ${e instanceof Error ? e.message : String(e)}`, 502);
    }
    const spec = {
      name: names.containerName(RELAY_SLUG),
      image: PLAYIT_IMAGE,
      env: { SECRET_KEY: secret },
      ports: [],
      binds: [],
      labels: { [LABEL_MANAGED]: "true", [LABEL_RELAY]: "true" },
      networkMode: "host" as const,
    };
    let id = await this.docker.create(spec);
    const env = await this.docker.containerEnv?.(id);
    if (env && env.SECRET_KEY !== secret) {
      await this.docker.remove(id);
      id = await this.docker.create(spec);
    }
    this.set(K_CONTAINER, id);
    if ((await this.docker.state(id)) !== "running") await this.docker.start(id);
  }

  private async removeAgent(): Promise<void> {
    const id = this.get(K_CONTAINER);
    if (!id) return;
    try {
      await this.docker.remove(id);
    } finally {
      this.del(K_CONTAINER);
    }
  }

  // ---------------------------------------------------------------- servers

  /** Turn a server's relay on: start the agent (managed mode), then create what can be created and read back what exists. */
  async enable(server: RelayServer): Promise<void> {
    if (!this.configured()) throw new RelayError("Add your playit.gg secret key under Settings first", 409);
    if (!this.localHost()) throw new RelayError("Tell Game Labs which address your playit.gg agent should use to reach this machine (Settings, Hide my IP), or set HOST_LAN_IP", 409);
    if (this.mode() === "managed") {
      try {
        await this.ensureAgent();
      } catch (e) {
        throw e instanceof RelayError ? e : new RelayError(`Could not start the playit.gg agent: ${e instanceof Error ? e.message : String(e)}`, 502);
      }
    }
    const client = this.makeClient(this.secret()!);
    let data: PlayitRundata;
    try {
      data = await client.rundata();
    } catch (e) {
      throw new RelayError(e instanceof PlayitError ? e.message : "Could not ask playit.gg", 502);
    }
    this.cache = { at: Date.now(), data, error: null };
    if (this.createRefused || !data.agentId) return;
    const have = this.matches(server, data);
    for (const t of planTunnels(server.slug, server.ports)) {
      if (have.has(t.name)) continue;
      try {
        const id = await client.createTunnel({ agentId: data.agentId, name: t.name, proto: t.protocol, localIp: this.localHost()!, localPort: t.port });
        if (id) this.remember(id);
      } catch (e) {
        // Refused (a read-only key, a plan limit): stop asking and let the person create the rest by hand.
        if (e instanceof PlayitError && e.kind !== "network") this.createRefused = e.message;
        break;
      }
    }
    await this.refresh();
  }

  /** Turn a server's relay off: remove the tunnels the panel itself created for it, then the agent when nothing uses it. */
  async disable(server: RelayServer, stillUsing: number): Promise<void> {
    const secret = this.secret();
    if (secret && this.cache?.data) {
      const client = this.makeClient(secret);
      const mine = new Set(this.created());
      for (const t of this.cache.data.tunnels) {
        if (!mine.has(t.id) || !t.name?.startsWith(`gl-${server.slug}-`)) continue;
        try {
          await client.deleteTunnel(t.id);
          this.forget(t.id);
        } catch {
          /* leave it: it only uses up a free tunnel */
        }
      }
    }
    if (stillUsing === 0) await this.removeAgent();
    this.cache = null;
  }

  private created(): string[] {
    try {
      const v = JSON.parse(this.get(K_CREATED) ?? "[]") as unknown;
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
    } catch {
      return [];
    }
  }
  private remember(id: string) {
    this.set(K_CREATED, JSON.stringify([...new Set([...this.created(), id])]));
  }
  private forget(id: string) {
    this.set(K_CREATED, JSON.stringify(this.created().filter((x) => x !== id)));
  }

  /** The planned tunnel names playit.gg already has for this server. A tunnel counts by its name, or by the local port it forwards when the answer says. */
  private matches(server: RelayServer, data: PlayitRundata): Map<string, { address: string | null }> {
    const out = new Map<string, { address: string | null }>();
    for (const t of planTunnels(server.slug, server.ports)) {
      const hit = data.tunnels.find((x) => x.name === t.name) ?? data.tunnels.find((x) => x.localPort === t.port && (x.proto === t.protocol || x.proto === "both" || t.protocol === "both") && !x.name?.startsWith("gl-"));
      if (hit) out.set(t.name, { address: hit.address });
    }
    return out;
  }

  /** Re-read what playit.gg says. Never throws: a problem is remembered and shown. */
  async refresh(): Promise<void> {
    const secret = this.secret();
    if (!secret) {
      this.cache = null;
      return;
    }
    try {
      this.cache = { at: Date.now(), data: await this.makeClient(secret).rundata(), error: null };
    } catch (e) {
      this.cache = { at: Date.now(), data: this.cache?.data ?? null, error: e instanceof PlayitError ? e.message : "Could not ask playit.gg" };
    }
  }

  /** Whether any server uses the relay, so a background check is worth making. */
  inUse(): boolean {
    return this.configured() && this.relayServers().length > 0;
  }

  /** What to show for one server. Reads only what the last refresh found, so it never waits on the network. */
  info(server: RelayServer): RelayInfo {
    const local = this.localHost();
    const plan = planTunnels(server.slug, server.ports);
    if (!this.configured() || !local) return { state: "error", address: null, tunnels: plan.map((t) => ({ ...t, local: `${local ?? "?"}:${t.port}`, address: null })), problem: !this.configured() ? "Add your playit.gg secret key under Settings" : "The agent's address for this machine is not set" };
    const data = this.cache?.data ?? null;
    const have = data ? this.matches(server, data) : new Map<string, { address: string | null }>();
    const tunnels = plan.map((t) => ({ ...t, local: `${local}:${t.port}`, address: have.get(t.name)?.address ?? null }));
    const address = tunnels[0]?.address ?? null;
    const allThere = tunnels.length > 0 && tunnels.every((t) => t.address);
    if (this.cache?.error && !allThere) return { state: "error", address, tunnels, problem: this.cache.error };
    return { state: allThere ? "ready" : "setup", address, tunnels, problem: this.createRefused && !allThere ? "playit.gg does not let the panel create tunnels with this key, so create them in the playit.gg dashboard" : null };
  }

  async status(): Promise<RelayStatus> {
    const mode = this.mode();
    const servers = this.relayServers();
    const tunnels = servers.flatMap((s) => planTunnels(s.slug, s.ports));
    const needs = { tcp: tunnels.filter((t) => t.protocol !== "udp").length, udp: tunnels.filter((t) => t.protocol !== "tcp").length, limit: FREE_TUNNELS };
    const over = needs.tcp > FREE_TUNNELS || needs.udp > FREE_TUNNELS;
    let agent: RelayStatus["agent"] = { state: "external", problem: null };
    if (mode === "managed") {
      const id = this.get(K_CONTAINER);
      const s = id ? await this.docker.state(id).catch(() => "missing" as const) : "missing";
      agent = { state: s === "running" ? "running" : s === "missing" ? "missing" : "stopped", problem: null };
    }
    return {
      configured: this.configured(),
      mode,
      localHost: this.get(K_LOCAL) ?? (mode === "existing" ? (this.config.HOST_LAN_IP ?? null) : null),
      needs,
      warning: over ? `The free playit.gg plan allows about ${FREE_TUNNELS} TCP and ${FREE_TUNNELS} UDP tunnels, and the servers on the relay need ${needs.tcp} TCP and ${needs.udp} UDP.` : null,
      agent,
      account: { checkedAt: this.cache ? new Date(this.cache.at).toISOString() : null, tunnels: this.cache?.data?.tunnels.length ?? null, status: this.cache?.data?.accountStatus ?? null, problem: this.cache?.error ?? null },
    };
  }
}
