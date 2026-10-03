import { chownSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import net from "node:net";
import { eq } from "drizzle-orm";
import type { Config } from "../config.js";
import type { Db } from "../db/index.js";
import { schema } from "../db/index.js";
import type { GameTemplate } from "../../shared/template.js";
import type { ContainerDriver, ContainerState } from "../docker/driver.js";
import { LABEL_ID, LABEL_MANAGED, LABEL_SLUG } from "../docker/driver.js";
import { RouterNotFoundError, type ConnectivityProvider } from "../connectivity/provider.js";
import type { DnsClient } from "../dns/cloudflare.js";
import { allocatePorts, checkPorts, portKey, type Allocation, type PortKey } from "../ports/allocator.js";
import { listHostPorts } from "../ports/host.js";
import { BackupStore, type BackupInfo } from "../backups.js";
import { queryA2s, type PlayerCount } from "../players/a2s.js";
import { slugify, uniqueSlug } from "../slug.js";

export class UserError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
    public readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export interface DeployRequest {
  templateId: string;
  name: string;
  env?: Record<string, string>;
  /** Optional manual port choices keyed by template port name. */
  ports?: Record<string, number>;
  access?: "private" | "public";
}

export interface ServiceDeps {
  config: Config;
  db: Db;
  templates: GameTemplate[];
  docker: ContainerDriver;
  connectivity: ConnectivityProvider;
  /** Fixed DNS client plus `config.PUBLIC_HOST` (used by tests and env-only setups). */
  dns?: DnsClient;
  /** Takes precedence over `dns`: lets DNS be configured at runtime from the Settings page. */
  dnsProvider?: () => DnsContext | undefined;
  hostPorts?: () => Set<PortKey>;
  /** Run the deploy in the background (default) or await it (tests). */
  background?: boolean;
  /** TCP probe used for readiness; injectable for tests. */
  probeTcp?: (port: number) => Promise<boolean>;
  readyTimeoutMs?: number;
  stableMs?: number;
  /** Sets a folder's owner; injectable because tests do not run as root. */
  chown?: (dir: string, uid: number, gid: number) => void;
  /** Player-count query for a template port with `query: a2s`; injectable for tests. */
  queryPlayers?: (host: string, port: number) => Promise<PlayerCount | null>;
}

export interface DnsContext {
  client: DnsClient;
  /** Hostname players' CNAMEs point at; its A record tracks the public IP. */
  host: string;
  zone: string | null;
}

const randomSecret = () => randomBytes(12).toString("base64url");

/** Ports with a bound UDP socket, from the contents of /proc/net/udp (and udp6). */
export function parseListeningUdp(text: string): Set<number> {
  const ports = new Set<number>();
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*\d+:\s+[0-9A-Fa-f]+:([0-9A-Fa-f]{4})\s/);
    if (m) ports.add(parseInt(m[1], 16));
  }
  return ports;
}

export function tcpProbe(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ port, host, timeout: 1500 });
    s.once("connect", () => (s.destroy(), resolve(true)));
    s.once("error", () => resolve(false));
    s.once("timeout", () => (s.destroy(), resolve(false)));
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class ServerService {
  constructor(private readonly d: ServiceDeps) {}

  /** The active DNS setup, or undefined when Cloudflare is not configured. */
  private dnsCtx(): DnsContext | undefined {
    if (this.d.dnsProvider) return this.d.dnsProvider();
    if (this.d.dns && this.d.config.PUBLIC_HOST) return { client: this.d.dns, host: this.d.config.PUBLIC_HOST, zone: this.d.config.CF_ZONE ?? null };
    return undefined;
  }

  private template(id: string): GameTemplate {
    const t = this.d.templates.find((x) => x.id === id);
    if (!t) throw new UserError(`Unknown template "${id}"`, 404);
    return t;
  }

  private row(id: string) {
    const row = this.d.db.select().from(schema.servers).where(eq(schema.servers.id, id)).get();
    if (!row) throw new UserError("Server not found", 404);
    return row;
  }

  private ports(id: string) {
    return this.d.db.select().from(schema.serverPorts).where(eq(schema.serverPorts.serverId, id)).all();
  }

  event(serverId: string | null, level: "info" | "warn" | "error", message: string) {
    this.d.db.insert(schema.events).values({ serverId, level, message, at: new Date() }).run();
  }

  private setStatus(id: string, status: (typeof schema.servers.$inferSelect)["status"], lastError: string | null = null) {
    this.d.db.update(schema.servers).set({ status, lastError }).where(eq(schema.servers.id, id)).run();
  }

  private takenPorts(): Set<PortKey> {
    return new Set(this.d.db.select().from(schema.serverPorts).all().map((p) => portKey(p.port, p.protocol)));
  }

  private busyPorts(): Set<PortKey> {
    return (this.d.hostPorts ?? (() => listHostPorts()))();
  }

  /** Preview what a deploy would allocate, so the form can show the real ports. */
  planPorts(templateId: string): Allocation[] {
    return allocatePorts(this.template(templateId).ports, this.takenPorts(), this.busyPorts());
  }

  // ---------------------------------------------------------------- deploy

  async deploy(req: DeployRequest): Promise<string> {
    const t = this.template(req.templateId);
    const name = req.name.trim();
    if (!name || name.length > 60) throw new UserError("Give the server a name (up to 60 characters)");

    const env: Record<string, string> = {};
    for (const [key, def] of Object.entries(t.env)) {
      let v = (req.env?.[key] ?? def.default ?? "").trim();
      if (!v && def.generate) v = randomSecret();
      if (!v && def.required) throw new UserError(`${def.label} is required`, 400, { field: key });
      if (v) env[key] = v;
    }

    const taken = this.takenPorts();
    const busy = this.busyPorts();
    let allocation: Allocation[];
    if (req.ports && Object.keys(req.ports).length > 0) {
      allocation = t.ports.map((p) => ({ name: p.name, port: req.ports![p.name] ?? p.default, protocol: p.protocol, env: p.env }));
      for (const a of allocation) {
        if (!Number.isInteger(a.port) || a.port < 1024 || a.port > 65535) throw new UserError(`Port ${a.port} is not valid (use 1024-65535)`);
      }
      try {
        checkPorts(allocation, t.ports, taken, busy);
      } catch (e) {
        if (e instanceof Error && "conflicts" in e) {
          const pc = e as unknown as { conflicts: string[]; suggestion: Allocation[] | null };
          throw new UserError(e.message, 409, { conflicts: pc.conflicts, suggestion: pc.suggestion });
        }
        throw e;
      }
    } else {
      allocation = allocatePorts(t.ports, taken, busy);
    }

    const existingSlugs = new Set(this.d.db.select({ slug: schema.servers.slug }).from(schema.servers).all().map((r) => r.slug));
    const slug = uniqueSlug(slugify(name), existingSlugs);
    const id = randomUUID();

    this.d.db.transaction((tx) => {
      tx.insert(schema.servers).values({ id, slug, name, templateId: t.id, status: "deploying", access: "private", env, createdAt: new Date() }).run();
      for (const a of allocation) tx.insert(schema.serverPorts).values({ serverId: id, name: a.name, port: a.port, protocol: a.protocol }).run();
    });
    this.event(id, "info", `Deploy started from template ${t.id}`);

    const job = this.runDeploy(id, req.access ?? "private");
    if (this.d.background === false) await job;
    else void job;
    return id;
  }

  /** Retry a failed deploy; every step is idempotent. */
  async retry(id: string): Promise<void> {
    const row = this.row(id);
    if (row.status !== "error") throw new UserError("Only servers in an error state can be retried", 409);
    this.setStatus(id, "deploying");
    const job = this.runDeploy(id, row.access);
    if (this.d.background === false) await job;
    else void job;
  }

  private async runDeploy(id: string, wantAccess: "private" | "public"): Promise<void> {
    const row = this.row(id);
    const t = this.template(row.templateId);
    const ports = this.ports(id);
    try {
      // Env: template ports are injected as env so the server listens where we mapped it.
      const env: Record<string, string> = { ...row.env };
      for (const tp of t.ports) {
        const p = ports.find((x) => x.name === tp.name)!;
        if (tp.env) env[tp.env] = String(p.port);
      }

      const dataRoot = path.join(this.d.config.GAMESERVERS_DIR, row.slug);
      const binds = t.data.map((dp, i) => {
        const host = t.data.length === 1 ? dataRoot : path.join(dataRoot, path.basename(dp.containerPath) || String(i));
        mkdirSync(host, { recursive: true });
        if (dp.owner) {
          try {
            (this.d.chown ?? chownSync)(host, dp.owner.uid, dp.owner.gid);
          } catch (e) {
            this.event(id, "warn", `Could not set the owner of ${host} to ${dp.owner.uid}:${dp.owner.gid}; if the game cannot write its files, run chown on that folder: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        return { host, container: dp.containerPath };
      });
      this.event(id, "info", `Pulling ${t.image}`);
      await this.d.docker.pullImage(t.image);

      const containerId = await this.d.docker.create({
        name: `gl-${row.slug}`,
        image: t.image,
        env,
        ports: ports.map((p) => ({ port: p.port, protocol: p.protocol })),
        binds,
        labels: { [LABEL_MANAGED]: "true", [LABEL_ID]: id, [LABEL_SLUG]: row.slug },
      });
      this.d.db.update(schema.servers).set({ containerId }).where(eq(schema.servers.id, id)).run();

      await this.d.docker.start(containerId);
      this.event(id, "info", "Container started, waiting for it to come up");
      await this.waitReady(containerId, t, ports);
      this.setStatus(id, "online");
      this.event(id, "info", "Server is online");

      if (wantAccess === "public") await this.applyAccess(id, "public");
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.setStatus(id, "error", message);
      this.event(id, "error", `Deploy failed: ${message}`);
    }
  }

  /**
   * Readiness: if the template has a TCP port we require it to accept connections; UDP-only games cannot be
   * probed that way, so we require the container to stay up for a short stable window instead.
   */
  private async waitReady(containerId: string, t: GameTemplate, ports: { name: string; port: number; protocol: string }[]) {
    const deadline = Date.now() + (this.d.readyTimeoutMs ?? 120_000);
    const tcpPort = ports.find((p) => p.protocol === "tcp");
    const probe = this.d.probeTcp ?? tcpProbe;
    const stable = this.d.stableMs ?? 8_000;
    let upSince: number | null = null;
    while (Date.now() < deadline) {
      const state = await this.d.docker.state(containerId);
      if (state !== "running") throw new Error(`Container stopped during startup (state: ${state}). Check the logs.`);
      upSince ??= Date.now();
      if (tcpPort ? await probe(tcpPort.port) : Date.now() - upSince >= stable) return;
      await sleep(tcpPort ? 1500 : 500);
    }
    throw new Error(`Server did not become ready in time (template ${t.id}). Check the logs.`);
  }

  // ------------------------------------------------------------- lifecycle

  async start(id: string) {
    const row = this.row(id);
    if (!row.containerId) throw new UserError("Server has no container yet", 409);
    await this.d.docker.start(row.containerId);
    this.setStatus(id, "online");
    this.event(id, "info", "Started");
    await this.reopenIfPublic(id);
  }

  /** A public server that was stopped may have lost its router mappings (reboot) while it was off; put them back. */
  private async reopenIfPublic(id: string) {
    const row = this.row(id);
    const lan = this.d.config.HOST_LAN_IP;
    if (row.access !== "public" || !lan) return;
    try {
      for (const p of this.ports(id)) await this.d.connectivity.ensureOpen(id, row.slug, p.port, p.protocol, lan);
    } catch (e) {
      this.event(id, "warn", `Could not check the router ports after starting: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async stop(id: string) {
    const row = this.row(id);
    if (!row.containerId) throw new UserError("Server has no container yet", 409);
    await this.d.docker.stop(row.containerId);
    this.setStatus(id, "offline");
    this.event(id, "info", "Stopped");
  }

  async restart(id: string) {
    const row = this.row(id);
    if (!row.containerId) throw new UserError("Server has no container yet", 409);
    await this.d.docker.restart(row.containerId);
    this.setStatus(id, "online");
    this.event(id, "info", "Restarted");
  }

  /** Remove the container, router mappings and DNS; keep world data unless asked. */
  async remove(id: string, opts: { deleteData?: boolean; confirmName?: string } = {}) {
    const row = this.row(id);
    if (opts.deleteData && opts.confirmName !== row.name) throw new UserError("Type the server name to delete its world data", 400);
    const errors: string[] = [];
    // Deleting world data leaves one last backup behind (outside the data folder), so a change of heart days later can still be undone.
    if (opts.deleteData && existsSync(path.join(this.d.config.GAMESERVERS_DIR, row.slug))) {
      try {
        await this.store().create(row.slug, { prune: false });
      } catch (e) {
        throw new UserError(`Could not make a final backup, so nothing was deleted: ${(e as Error).message}`, 500);
      }
    }
    await this.closeAccess(row, errors);
    if (row.containerId) await this.d.docker.remove(row.containerId);
    if (opts.deleteData) rmSync(path.join(this.d.config.GAMESERVERS_DIR, row.slug), { recursive: true, force: true });
    this.d.db.delete(schema.servers).where(eq(schema.servers.id, id)).run();
    this.event(null, "info", `Deleted ${row.slug}${opts.deleteData ? " and its world data" : " (data kept)"}`);
    return { warnings: errors };
  }

  // ---------------------------------------------------------------- access

  async setAccess(id: string, access: "private" | "public") {
    const row = this.row(id);
    if (access === "public" && row.status === "error") throw new UserError("Fix the server error before making it public", 409);
    await this.applyAccess(id, access);
    return row;
  }

  private lanIp(): string {
    const ip = this.d.config.HOST_LAN_IP;
    if (!ip) throw new UserError("Set HOST_LAN_IP in your .env so the router knows where to send traffic", 400);
    return ip;
  }

  private async applyAccess(id: string, access: "private" | "public") {
    const row = this.row(id);
    const ports = this.ports(id);
    if (access === "public") {
      const lan = this.lanIp();
      try {
        for (const p of ports) await this.d.connectivity.ensureOpen(id, row.slug, p.port, p.protocol, lan);
        const dns = this.dnsCtx();
        if (dns) {
          await this.syncDdns();
          await dns.client.upsertCname(row.slug, dns.host);
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        this.event(id, "error", `Could not make public: ${message}`);
        throw new UserError(message, 502);
      }
    } else {
      const errors: string[] = [];
      await this.closeAccess(row, errors);
      if (errors.length > 0) {
        this.event(id, "warn", `Made private with problems: ${errors.join("; ")}`);
        this.d.db.update(schema.servers).set({ access }).where(eq(schema.servers.id, id)).run();
        throw new UserError(`Made private, but cleanup had problems: ${errors.join("; ")}`, 502);
      }
    }
    this.d.db.update(schema.servers).set({ access }).where(eq(schema.servers.id, id)).run();
    this.event(id, "info", `Access set to ${access}`);
  }

  /** Best-effort teardown of router mappings and DNS; collects problems instead of throwing. */
  private async closeAccess(row: typeof schema.servers.$inferSelect, errors: string[]) {
    for (const p of this.ports(row.id)) {
      try {
        await this.d.connectivity.ensureClosed(row.id, row.slug, p.port, p.protocol);
      } catch (e) {
        errors.push(e instanceof Error ? e.message : String(e));
      }
    }
    const dns = this.dnsCtx();
    if (dns) {
      try {
        await dns.client.deleteCname(row.slug);
      } catch (e) {
        errors.push(e instanceof Error ? e.message : String(e));
      }
    }
  }

  /** Point PUBLIC_HOST at the current public IP (dynamic DNS). */
  async syncDdns(): Promise<{ ip: string; result: string } | null> {
    const { connectivity, db } = this.d;
    const ctx = this.dnsCtx();
    if (!ctx) return null;
    const ip = await connectivity.externalIp();
    const result = await ctx.client.upsertA(ctx.host, ip);
    const now = new Date().toISOString();
    for (const [key, value] of [["public_ip", ip], ["ddns_updated_at", now]] as const) {
      db.insert(schema.settings).values({ key, value }).onConflictDoUpdate({ target: schema.settings.key, set: { value } }).run();
    }
    return { ip, result };
  }

  // ------------------------------------------------------------- reconcile

  /**
   * Bring reality back in line with the database. Runs at startup and every few minutes: routers drop UPnP
   * mappings on reboot, DNS records get deleted, public IPs change, containers get removed by hand.
   * Only ever touches containers/mappings/records that carry the gamelabs tag. Returns what it did.
   */
  private routerMissStreak = 0;

  async reconcile(): Promise<string[]> {
    const actions: string[] = [];
    const problems: string[] = [];
    // A router that does not answer discovery is usually a one-off. Note it, skip the rest of the router work
    // this round, and only complain once it has been missing on two rounds in a row.
    let routerMissing: string | null = null;
    const attempt = async (what: string, fn: () => Promise<void>) => {
      if (routerMissing) return;
      try {
        await fn();
      } catch (e) {
        if (e instanceof RouterNotFoundError) routerMissing = e.message;
        else problems.push(`${what}: ${e instanceof Error ? e.message : String(e)}`);
      }
    };

    // 1. Containers: recreate any that vanished; sync status for the rest.
    for (const r of this.d.db.select().from(schema.servers).all()) {
      if (r.status === "deploying" || r.status === "error") continue;
      if (r.containerId && (await this.d.docker.state(r.containerId).catch(() => "exited" as const)) === "missing") {
        actions.push(`recreated missing container for ${r.slug}`);
        this.event(r.id, "warn", "Container was missing; recreating");
        this.setStatus(r.id, "deploying");
        await this.runDeploy(r.id, r.access);
      }
    }
    await this.refreshStatuses();

    const servers = this.d.db.select().from(schema.servers).all();
    const publicServers = servers.filter((s) => s.access === "public" && s.status !== "error");

    // 2. Router mappings for public servers (a router reboot wipes them).
    const lan = this.d.config.HOST_LAN_IP;
    if (lan) {
      // A stopped server has nothing listening, so its ports are left alone until it is started again.
      for (const s of publicServers.filter((x) => x.status !== "offline")) {
        for (const p of this.ports(s.id)) {
          await attempt(`${s.slug} ${p.port}/${p.protocol}`, async () => {
            const owned = await this.d.connectivity.list();
            const had = owned.some((m) => m.port === p.port && m.protocol === p.protocol && m.description === `gamelabs:${s.slug}`);
            await this.d.connectivity.ensureOpen(s.id, s.slug, p.port, p.protocol, lan);
            if (!had && this.d.connectivity.kind === "upnp") actions.push(`re-opened ${p.port}/${p.protocol} for ${s.slug}`);
          });
        }
      }
    }

    // 3. DNS: DDNS A record, CNAMEs for public servers, drop tagged CNAMEs for everything else.
    const dnsCtx = this.dnsCtx();
    if (dnsCtx) {
      const dns = dnsCtx.client;
      const host = dnsCtx.host;
      await attempt("ddns", async () => {
        const r = await this.syncDdns();
        if (r && r.result !== "unchanged") actions.push(`DDNS ${r.result} (${r.ip})`);
      });
      await attempt("dns", async () => {
        const owned = new Set(await dns.listOwnedCnames());
        for (const s of publicServers) {
          if (!owned.has(s.slug)) {
            await dns.upsertCname(s.slug, host);
            actions.push(`restored DNS record for ${s.slug}`);
          }
        }
        const wanted = new Set(publicServers.map((s) => s.slug));
        for (const slug of owned) {
          if (!wanted.has(slug)) {
            await dns.deleteCname(slug);
            actions.push(`removed stale DNS record for ${slug}`);
          }
        }
      });
    }

    if (routerMissing) {
      this.routerMissStreak++;
      if (this.routerMissStreak >= 2) problems.push(routerMissing);
    } else {
      this.routerMissStreak = 0;
    }

    for (const a of actions) this.event(null, "info", `Reconcile: ${a}`);
    for (const p of problems) this.event(null, "warn", `Reconcile problem: ${p}`);
    const now = new Date().toISOString();
    for (const [key, value] of [["reconcile_at", now], ["reconcile_problems", JSON.stringify(problems)]] as const) {
      this.d.db.insert(schema.settings).values({ key, value }).onConflictDoUpdate({ target: schema.settings.key, set: { value } }).run();
    }
    return actions;
  }

  // ------------------------------------------------------------------ read

  /** Reconcile stored status with Docker's view for steady-state servers. */
  async refreshStatuses() {
    const rows = this.d.db.select().from(schema.servers).all();
    for (const r of rows) {
      if (!r.containerId || r.status === "deploying" || r.status === "error") continue;
      const state: ContainerState = await this.d.docker.state(r.containerId).catch(() => "missing");
      const next = state === "running" ? "online" : state === "paused" ? "paused" : state === "exited" ? "offline" : "error";
      if (next !== r.status) this.setStatus(r.id, next, state === "missing" ? "The container is missing from Docker" : null);
    }
  }

  /** `${containerId}@${startedAt}` of runs already seen with their game port open. A restart is a new run. */
  private readyRuns = new Set<string>();

  /**
   * True while a running container's game has not opened its main port yet (first-run downloads, world loading).
   * A TCP port is probed from the host. UDP cannot be probed from outside, so we look inside the container for a
   * bound UDP socket on the game port. If that cannot be read (no `cat` in the image), assume ready.
   */
  private async isStarting(r: typeof schema.servers.$inferSelect): Promise<boolean> {
    if (r.status !== "online" || !r.containerId) return false;
    const tpl = this.d.templates.find((x) => x.id === r.templateId);
    const main = tpl?.ports[0];
    const mine = main && this.ports(r.id).find((p) => p.name === main.name);
    if (!mine) return false;
    const key = `${r.containerId}@${(await this.d.docker.startedAt(r.containerId)) ?? "?"}`;
    if (this.readyRuns.has(key)) return false;
    let listening: boolean;
    try {
      if (mine.protocol === "tcp") listening = await (this.d.probeTcp ?? tcpProbe)(mine.port);
      else {
        const [v4, v6] = await Promise.all(["/proc/net/udp", "/proc/net/udp6"].map((f) => this.d.docker.exec(r.containerId!, ["cat", f], { timeoutMs: 4000 })));
        listening = parseListeningUdp(v4.output + "\n" + v6.output).has(mine.port);
        if (v4.exitCode !== 0 && v4.exitCode !== null) return false; // cannot tell: do not claim "starting" forever
      }
    } catch {
      return false;
    }
    if (listening) this.readyRuns.add(key);
    return !listening;
  }

  async list() {
    await this.refreshStatuses();
    const rows = this.d.db.select().from(schema.servers).all();
    const starting = new Set((await Promise.all(rows.map(async (r) => ((await this.isStarting(r)) ? r.id : null)))).filter((x): x is string => x !== null));
    const ports = this.d.db.select().from(schema.serverPorts).all();
    const rules = this.d.db.select().from(schema.manualRules).all();
    const t = (id: string) => this.d.templates.find((x) => x.id === id);
    return rows.map((r) => {
      const sp = ports.filter((p) => p.serverId === r.id);
      const tpl = t(r.templateId);
      const gamePort = sp[0];
      const dnsC = this.dnsCtx();
      const host = dnsC ? dnsC.client.fqdn(r.slug) : this.d.config.PUBLIC_HOST;
      const secrets = tpl ? Object.entries(tpl.env).filter(([, v]) => v.secret).map(([k]) => k) : [];
      return {
        id: r.id,
        slug: r.slug,
        name: r.name,
        templateId: r.templateId,
        templateName: tpl?.name ?? r.templateId,
        status: r.status,
        starting: starting.has(r.id),
        access: r.access,
        lastError: r.lastError,
        ports: sp.map((p) => ({ name: p.name, port: p.port, protocol: p.protocol })),
        secrets,
        connect: {
          lan: this.d.config.HOST_LAN_IP && gamePort ? `${this.d.config.HOST_LAN_IP}:${gamePort.port}` : null,
          public: r.access === "public" && host && gamePort ? `${host}:${gamePort.port}` : null,
          instructions: r.access === "public" && tpl?.join.method === "server-browser" ? (tpl.join.instructions ?? null) : null,
        },
        pendingRules: this.d.connectivity.kind !== "manual" ? [] : rules.filter((x) => x.serverId === r.id && !x.confirmed).map((x) => ({ id: x.id, port: x.port, protocol: x.protocol })),
      };
    });
  }

  /** CPU, memory and player count for each running server, keyed by server id. Anything that fails is left out. */
  async usage(): Promise<Record<string, { cpuPercent: number | null; memBytes: number; players: PlayerCount | null }>> {
    const rows = this.d.db.select().from(schema.servers).all().filter((r) => r.containerId && r.status === "online");
    const ports = this.d.db.select().from(schema.serverPorts).all();
    const queryPlayers = this.d.queryPlayers ?? ((host: string, port: number) => queryA2s(host, port));
    const out: Record<string, { cpuPercent: number | null; memBytes: number; players: PlayerCount | null }> = {};
    await Promise.all(
      rows.map(async (r) => {
        try {
          const u = await this.d.docker.usage(r.containerId!);
          const tpl = this.d.templates.find((x) => x.id === r.templateId);
          const q = tpl?.ports.find((p) => p.query === "a2s");
          const mine = q && ports.find((p) => p.serverId === r.id && p.name === q.name);
          const players = mine ? await queryPlayers("127.0.0.1", mine.port).catch(() => null) : null;
          out[r.id] = { ...u, players };
        } catch {
          /* container gone or Docker busy: show nothing rather than a wrong number */
        }
      }),
    );
    return out;
  }

  // --------------------------------------------------------------- backups

  private backups?: BackupStore;
  private busyBackups = new Set<string>();

  private store() {
    return (this.backups ??= new BackupStore(this.d.config.GAMESERVERS_DIR, this.d.config.BACKUP_KEEP));
  }

  /** One backup or restore at a time per server. */
  private async exclusive<T>(slug: string, fn: () => Promise<T>): Promise<T> {
    if (this.busyBackups.has(slug)) throw new UserError("A backup or restore is already running for this server", 409);
    this.busyBackups.add(slug);
    try {
      return await fn();
    } catch (e) {
      throw e instanceof UserError ? e : new UserError(e instanceof Error ? e.message : String(e), 500);
    } finally {
      this.busyBackups.delete(slug);
    }
  }

  listBackups(id: string): BackupInfo[] {
    return this.store().list(this.row(id).slug);
  }

  /** Back up while the server keeps running. For a fully consistent copy, stop the server first. */
  async backup(id: string): Promise<BackupInfo> {
    const row = this.row(id);
    return this.exclusive(row.slug, async () => {
      const info = await this.store().create(row.slug);
      this.event(id, "info", `Backup ${info.name} created`);
      return info;
    });
  }

  /**
   * Back up every server whose interval has passed. A stopped server that already has a backup is skipped,
   * since its data is not changing. Returns what it did, for the log.
   */
  async runScheduledBackups(now = Date.now()): Promise<string[]> {
    const done: string[] = [];
    for (const r of this.d.db.select().from(schema.servers).all()) {
      if (!r.containerId || r.status === "deploying" || r.status === "error") continue;
      if (!existsSync(path.join(this.d.config.GAMESERVERS_DIR, r.slug))) continue;
      const { everyHours } = this.store().settings(r.slug);
      if (everyHours === 0 || this.busyBackups.has(r.slug)) continue;
      const latest = this.store().list(r.slug)[0];
      if (latest && (r.status === "offline" || now - new Date(latest.createdAt).getTime() < everyHours * 3_600_000)) continue;
      try {
        const info = await this.backup(r.id);
        done.push(`${r.slug}: ${info.name}`);
      } catch (e) {
        this.event(r.id, "error", `Scheduled backup failed: ${(e as Error).message}`);
      }
    }
    return done;
  }

  backupSettings(id: string) {
    return this.store().settings(this.row(id).slug);
  }

  setBackupSettings(id: string, input: unknown) {
    try {
      return this.store().setSettings(this.row(id).slug, input);
    } catch (e) {
      throw e instanceof UserError ? e : new UserError((e as Error).message, 400);
    }
  }

  deleteBackup(id: string, name: string) {
    const row = this.row(id);
    try {
      this.store().remove(row.slug, name);
    } catch (e) {
      throw new UserError((e as Error).message, 404);
    }
  }

  /** Stop the server, take a safety backup of what is there now, swap in the chosen backup, start again if it was running. */
  async restoreBackup(id: string, name: string): Promise<void> {
    const row = this.row(id);
    if (!this.store().list(row.slug).some((b) => b.name === name)) throw new UserError("Backup not found", 404);
    return this.exclusive(row.slug, async () => {
      const wasRunning = row.containerId ? (await this.d.docker.state(row.containerId)) === "running" : false;
      if (wasRunning) await this.d.docker.stop(row.containerId!);
      try {
        const safety = await this.store().create(row.slug, { prune: false });
        await this.store().restore(row.slug, name);
        this.event(id, "info", `Restored ${name} (the previous state was saved as ${safety.name})`);
      } finally {
        if (wasRunning) await this.d.docker.start(row.containerId!);
      }
    });
  }

  secret(id: string, key: string): string {
    const row = this.row(id);
    const def = this.template(row.templateId).env[key];
    if (!def?.secret) throw new UserError("Not a secret setting", 404);
    return row.env[key] ?? "";
  }

  events(id: string, limit = 50) {
    return this.d.db.select().from(schema.events).where(eq(schema.events.serverId, id)).all().slice(-limit);
  }

  getRow(id: string) {
    return this.row(id);
  }

  async network() {
    const { connectivity, config, db } = this.d;
    const rules = db
      .select({ id: schema.manualRules.id, port: schema.manualRules.port, protocol: schema.manualRules.protocol, confirmed: schema.manualRules.confirmed, slug: schema.servers.slug })
      .from(schema.manualRules)
      .innerJoin(schema.servers, eq(schema.servers.id, schema.manualRules.serverId))
      .all();
    let publicIp: string | null = null;
    let ipError: string | null = null;
    try {
      publicIp = await connectivity.externalIp();
    } catch (e) {
      ipError = e instanceof Error ? e.message : String(e);
    }
    const mappings: { list: Awaited<ReturnType<typeof connectivity.list>>; error: string | null } = { list: [], error: null };
    if (connectivity.kind === "upnp") {
      try {
        mappings.list = await connectivity.list();
      } catch (e) {
        mappings.error = e instanceof Error ? e.message : String(e);
      }
    }
    const dnsNow = this.dnsCtx();
    const setting = (k: string) => db.select().from(schema.settings).where(eq(schema.settings.key, k)).get()?.value ?? null;
    return {
      provider: connectivity.kind,
      lanIp: config.HOST_LAN_IP ?? null,
      publicIp,
      ipError,
      reconcile: { at: setting("reconcile_at"), problems: JSON.parse(setting("reconcile_problems") ?? "[]") as string[] },
      dns: dnsNow ? { host: dnsNow.host, zone: dnsNow.zone, lastUpdate: setting("ddns_updated_at"), lastIp: setting("public_ip") } : null,
      rules: connectivity.kind === "manual" ? rules : [],
      mappings: mappings.list,
      mappingsError: mappings.error,
    };
  }

  async diagnostics(): Promise<{ provider: string; output: string | null }> {
    const c = this.d.connectivity;
    return { provider: c.kind, output: c.diagnose ? await c.diagnose().catch((e: unknown) => `Error: ${e instanceof Error ? e.message : String(e)}`) : null };
  }

  confirmRule(ruleId: number, confirmed: boolean) {
    const res = this.d.db.update(schema.manualRules).set({ confirmed }).where(eq(schema.manualRules.id, ruleId)).run();
    if (res.changes === 0) throw new UserError("Rule not found", 404);
  }
}
