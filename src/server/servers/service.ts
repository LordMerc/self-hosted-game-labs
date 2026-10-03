import { chownSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import net from "node:net";
import { eq } from "drizzle-orm";
import type { Config } from "../config.js";
import type { Db } from "../db/index.js";
import { schema } from "../db/index.js";
import { templateSchema, type GameTemplate } from "../../shared/template.js";
import type { ContainerDriver, ContainerState } from "../docker/driver.js";
import { LABEL_ID, LABEL_MANAGED, LABEL_SLUG } from "../docker/driver.js";
import { names } from "../instance.js";
import { describeMapping, RouterNotFoundError, type ConnectivityProvider } from "../connectivity/provider.js";
import type { DnsClient } from "../dns/cloudflare.js";
import { allocatePorts, checkPorts, portKey, type Allocation, type PortKey } from "../ports/allocator.js";
import { listHostPorts } from "../ports/host.js";
import { BackupStore, type BackupInfo } from "../backups.js";
import { queryA2s, type PlayerCount } from "../players/a2s.js";
import { buildCustomTemplate, checkCustomInput, isCustomId, type CustomInput } from "./custom.js";
import type { TcpProbe } from "../reachability.js";
import { CareStore, compareVersions, dayKey, dockerHubTags, dueStatus, isDockerHubImage, newestTag, repoOf, tagOf, type CareSettings, type TagLister, type UpdateCheck } from "../care.js";
import { queryMinecraft } from "../players/minecraft.js";
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
  /** Set the new server up from this backup: its world is put in place before the server first starts. */
  restoreFrom?: { slug: string; name: string };
}

/** One server's backups for the Backups page. `deleted` means no server with this name exists any more. */
export interface BackupGroup {
  slug: string;
  name: string;
  deleted: boolean;
  serverId: string | null;
  status: (typeof schema.servers.$inferSelect)["status"] | null;
  templateId: string | null;
  templateName: string | null;
  backups: BackupInfo[];
  totalBytes: number;
  /** What was saved about the server, for setting it up again. Passwords are listed by name only. */
  saved: { name: string; templateId: string | null; env: Record<string, string>; savedSecrets: string[]; access: "private" | "public" } | null;
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
  stableMs?: number;
  /** Asks an outside machine whether a TCP port answers. Absent or null: the outside check is off. */
  portProbe?: TcpProbe | null;
  /** Lists the version tags of a Docker Hub image, to tell when a newer one exists; injectable for tests. */
  tagLister?: TagLister;
  /** Sets a folder's owner; injectable because tests do not run as root. */
  chown?: (dir: string, uid: number, gid: number) => void;
  /** Player-count query for a template port with a `query` kind; injectable for tests. */
  queryPlayers?: (host: string, port: number, kind: "a2s" | "minecraft") => Promise<PlayerCount | null>;
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

/** Reject a value the template says is not allowed (a choice that is not offered, or text of the wrong shape). */
function checkEnvValue(key: string, def: GameTemplate["env"][string], v: string) {
  if (!v) return;
  if (def.choices && !def.choices.includes(v)) throw new UserError(`${def.label} must be one of: ${def.choices.join(", ")}`, 400, { field: key });
  if (def.pattern !== undefined && !new RegExp(`^(?:${def.pattern})$`).test(v)) {
    throw new UserError(`${def.label} ${def.patternMessage ?? "is not in the expected format"}`, 400, { field: key });
  }
}

/** The container's start-up arguments with `${NAME}` filled in from the server's settings. An argument that ends up empty is dropped. */
export function expandCommand(command: string[], env: Record<string, string>): string[] {
  return command.map((arg) => arg.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_, k: string) => env[k] ?? "")).filter((a) => a !== "");
}

const CUSTOM_KEY = "custom-templates";

export type ReachState = "open" | "closed" | "unknown" | "forwarded" | "not-forwarded" | "stopped";

export interface ReachItem {
  serverId: string;
  name: string;
  port: number;
  protocol: "tcp" | "udp";
  state: ReachState;
  detail: string;
}

export interface Reachability {
  state: "ok" | "problem" | "forwarded" | "unknown";
  text: string;
  at: string;
}

/** One line per server out of the per-port results. A problem outranks good news, because it is what the person needs to see. */
function summarize(items: ReachItem[], at: string): Reachability {
  const bad = items.find((i) => i.state === "closed" || i.state === "not-forwarded");
  if (bad) return { state: "problem", text: bad.state === "closed" ? `Port ${bad.port} is not reachable from the internet` : `The router is not forwarding ${bad.port}/${bad.protocol}`, at };
  const open = items.find((i) => i.state === "open");
  if (open) return { state: "ok", text: "Reachable from the internet", at };
  const fwd = items.find((i) => i.state === "forwarded");
  if (fwd) return { state: "forwarded", text: "Router forwards the port. UDP can't be tested from outside", at };
  return { state: "unknown", text: items[0]?.detail ?? "Could not be checked", at };
}

export class ServerService {
  constructor(private readonly d: ServiceDeps) {
    this.loadCustomTemplates();
  }

  // ------------------------------------------------------- custom images

  /** Custom-image templates are saved in the database and added to the template list at start-up. They are not shown as catalog entries. */
  private loadCustomTemplates() {
    const raw = this.d.db.select().from(schema.settings).where(eq(schema.settings.key, CUSTOM_KEY)).get()?.value;
    if (!raw) return;
    try {
      for (const t of JSON.parse(raw) as unknown[]) {
        const parsed = templateSchema.safeParse(t);
        if (parsed.success && isCustomId(parsed.data.id) && !this.d.templates.some((x) => x.id === parsed.data.id)) this.d.templates.push(parsed.data);
      }
    } catch {
      /* unreadable: start without them */
    }
  }

  private saveCustomTemplates() {
    const value = JSON.stringify(this.d.templates.filter((t) => isCustomId(t.id)));
    this.d.db.insert(schema.settings).values({ key: CUSTOM_KEY, value }).onConflictDoUpdate({ target: schema.settings.key, set: { value } }).run();
  }

  /** Set up a server from any Docker image. Ports are used exactly as given, because the image decides where it listens. */
  async deployCustom(req: CustomInput & { access?: "private" | "public" }): Promise<string> {
    const name = req.name.trim();
    if (!name || name.length > 60) throw new UserError("Give the server a name (up to 60 characters)");
    const problem = checkCustomInput(req);
    if (problem) throw new UserError(problem);
    const t = buildCustomTemplate(req, new Set(this.d.templates.map((x) => x.id)));
    this.d.templates.push(t);
    try {
      const id = await this.deploy({
        templateId: t.id,
        name,
        env: req.env,
        ports: Object.fromEntries(t.ports.map((p) => [p.name, p.default])),
        access: req.access,
      });
      this.saveCustomTemplates();
      return id;
    } catch (e) {
      this.d.templates.splice(this.d.templates.indexOf(t), 1);
      throw e;
    }
  }

  /** Forget a custom template once nothing uses it and nothing of the server is left to set up again. */
  private dropCustomTemplate(templateId: string, slug: string) {
    if (!isCustomId(templateId)) return;
    if (this.d.db.select().from(schema.servers).where(eq(schema.servers.templateId, templateId)).all().length > 0) return;
    if (existsSync(path.join(this.d.config.GAMESERVERS_DIR, slug)) || this.store().list(slug).length > 0) return;
    const i = this.d.templates.findIndex((x) => x.id === templateId);
    if (i >= 0) this.d.templates.splice(i, 1);
    this.saveCustomTemplates();
  }

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
      checkEnvValue(key, def, v);
      if (v) env[key] = v;
    }

    const taken = this.takenPorts();
    const busy = this.busyPorts();
    let allocation: Allocation[];
    // A custom image has no setting that moves its ports, so it gets exactly the ports it was given (a clash is an error).
    const chosen = req.ports && Object.keys(req.ports).length > 0 ? req.ports : isCustomId(t.id) ? Object.fromEntries(t.ports.map((p) => [p.name, p.default])) : undefined;
    if (chosen) {
      allocation = t.ports.map((p) => ({ name: p.name, port: chosen[p.name] ?? p.default, protocol: p.protocol, env: p.env }));
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

    if (req.restoreFrom) {
      const from = req.restoreFrom;
      await this.exclusive(slug, async () => {
        // A data folder left behind by the deleted server is replaced, after a copy of it is kept.
        if (existsSync(path.join(this.d.config.GAMESERVERS_DIR, slug))) await this.store().create(slug, { prune: false });
        await this.store().restore(from.slug, from.name, Date.now(), slug);
      });
    }

    this.d.db.transaction((tx) => {
      tx.insert(schema.servers).values({ id, slug, name, templateId: t.id, status: "deploying", access: "private", env, createdAt: new Date() }).run();
      for (const a of allocation) tx.insert(schema.serverPorts).values({ serverId: id, name: a.name, port: a.port, protocol: a.protocol }).run();
    });
    this.event(id, "info", `Deploy started from template ${t.id}${req.restoreFrom ? `, with the world from backup ${req.restoreFrom.name}` : ""}`);

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

  private async runDeploy(id: string, wantAccess: "private" | "public", opts: { pull?: boolean } = {}): Promise<void> {
    const row = this.row(id);
    const t = this.template(row.templateId);
    const ports = this.ports(id);
    const image = this.imageFor(row);
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
      if (opts.pull !== false) {
        this.event(id, "info", `Pulling ${image}`);
        await this.d.docker.pullImage(image);
      }

      const containerId = await this.d.docker.create({
        name: names.containerName(row.slug),
        image,
        env,
        ...(t.command ? { command: expandCommand(t.command, env) } : {}),
        ...(t.tty ? { tty: true } : {}),
        ports: ports.map((p) => ({ port: p.port, protocol: p.protocol })),
        binds,
        labels: { [LABEL_MANAGED]: "true", [LABEL_ID]: id, [LABEL_SLUG]: row.slug },
      });
      this.d.db.update(schema.servers).set({ containerId }).where(eq(schema.servers.id, id)).run();

      await this.d.docker.start(containerId);
      this.event(id, "info", "Container started, waiting for it to come up");
      await this.waitReady(containerId);
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
   * Deploy is done once the container has stayed up for a short stable window. Games can take many minutes after
   * that (first-run downloads, world generation), so the game port opening is not awaited here: the server list
   * shows "Starting" until it does (see `isStarting`).
   */
  private async waitReady(containerId: string) {
    const stable = this.d.stableMs ?? 8_000;
    const started = Date.now();
    for (;;) {
      const state = await this.d.docker.state(containerId);
      if (state !== "running") throw new Error(`Container stopped during startup (state: ${state}). Check the logs.`);
      if (Date.now() - started >= stable) return;
      await sleep(500);
    }
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
    this.saveBackupMeta(row);
    await this.closeAccess(row, errors);
    if (row.containerId) await this.d.docker.remove(row.containerId);
    if (opts.deleteData) rmSync(path.join(this.d.config.GAMESERVERS_DIR, row.slug), { recursive: true, force: true });
    this.d.db.delete(schema.servers).where(eq(schema.servers.id, id)).run();
    this.reach.delete(id);
    this.careStore().drop(id);
    this.dropCustomTemplate(row.templateId, row.slug);
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
            const had = owned.some((m) => m.port === p.port && m.protocol === p.protocol && m.description === describeMapping(s.slug));
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

    await attempt("backup records", async () => {
      for (const r of servers) this.saveBackupMeta(r);
    });
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
      const check = this.careStore().state(r.id).check;
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
        reachability: r.access === "public" ? (this.reach.get(r.id) ?? null) : null,
        update: check?.available ? { to: check.latest ?? "a newer build" } : null,
        pendingRules: this.d.connectivity.kind !== "manual" ? [] : rules.filter((x) => x.serverId === r.id && !x.confirmed).map((x) => ({ id: x.id, port: x.port, protocol: x.protocol })),
      };
    });
  }

  /** CPU, memory and player count for each running server, keyed by server id. Anything that fails is left out. */
  async usage(): Promise<Record<string, { cpuPercent: number | null; memBytes: number; players: PlayerCount | null }>> {
    const rows = this.d.db.select().from(schema.servers).all().filter((r) => r.containerId && r.status === "online");
    const ports = this.d.db.select().from(schema.serverPorts).all();
    const queryPlayers = this.d.queryPlayers ?? ((host: string, port: number, kind: "a2s" | "minecraft") => (kind === "minecraft" ? queryMinecraft(host, port) : queryA2s(host, port)));
    const out: Record<string, { cpuPercent: number | null; memBytes: number; players: PlayerCount | null }> = {};
    await Promise.all(
      rows.map(async (r) => {
        try {
          const u = await this.d.docker.usage(r.containerId!);
          const tpl = this.d.templates.find((x) => x.id === r.templateId);
          const q = tpl?.ports.find((p) => p.query !== "none");
          const mine = q && ports.find((p) => p.serverId === r.id && p.name === q.name);
          const players = mine ? await queryPlayers("127.0.0.1", mine.port, q!.query as "a2s" | "minecraft").catch(() => null) : null;
          out[r.id] = { ...u, players };
        } catch {
          /* container gone or Docker busy: show nothing rather than a wrong number */
        }
      }),
    );
    return out;
  }

  // ---------------------------------------------------------- detail page

  /** Everything the server page shows: the list entry, the editable settings (secrets are not sent), and whether there is a console. */
  async detail(id: string) {
    const row = this.row(id);
    const tpl = this.template(row.templateId);
    const server = (await this.list()).find((s) => s.id === id)!;
    return {
      server,
      env: Object.entries(tpl.env).map(([key, def]) => ({
        key,
        label: def.label,
        help: def.help ?? null,
        choices: def.choices ?? null,
        required: def.required,
        secret: def.secret,
        generate: def.generate,
        value: def.secret ? null : (row.env[key] ?? ""),
        isSet: Boolean(row.env[key]),
      })),
      console: tpl.console ? { examples: tpl.console.examples } : null,
      care: this.careInfo(id),
      events: this.events(id, 30).reverse(),
    };
  }

  /**
   * Change the name and/or settings. Settings only take effect in a new container, so a change to them recreates the
   * container (the world data folder is kept) and the server restarts. A name-only change is instant.
   * For each setting: left out = unchanged; empty = cleared (or a new random value for a generated password).
   */
  async updateSettings(id: string, input: { name?: string; env?: Record<string, string> }): Promise<{ restarting: boolean }> {
    const row = this.row(id);
    const tpl = this.template(row.templateId);
    if (row.status === "deploying" || row.status === "updating") throw new UserError("Wait for the server to finish starting before changing its settings", 409);

    const name = input.name === undefined ? row.name : input.name.trim();
    if (!name || name.length > 60) throw new UserError("Give the server a name (up to 60 characters)");

    const env = { ...row.env };
    for (const [key, raw] of Object.entries(input.env ?? {})) {
      const def = tpl.env[key];
      if (!def) throw new UserError(`Unknown setting ${key}`, 400, { field: key });
      let v = String(raw).trim();
      if (!v && def.generate) v = randomSecret();
      if (!v && def.required) throw new UserError(`${def.label} is required`, 400, { field: key });
      checkEnvValue(key, def, v);
      if (v) env[key] = v;
      else delete env[key];
    }
    const envChanged = JSON.stringify(Object.entries(env).sort()) !== JSON.stringify(Object.entries(row.env).sort());

    this.d.db.update(schema.servers).set({ name, env }).where(eq(schema.servers.id, id)).run();
    if (!envChanged) {
      if (name !== row.name) this.event(id, "info", "Renamed");
      return { restarting: false };
    }
    this.event(id, "info", "Settings changed; recreating the container to apply them (world data is kept)");
    if (row.containerId) {
      this.setStatus(id, "updating");
      try {
        await this.d.docker.remove(row.containerId);
      } catch (e) {
        this.setStatus(id, row.status, null);
        throw new UserError(`Could not stop the old container: ${e instanceof Error ? e.message : String(e)}`, 502);
      }
    } else {
      this.setStatus(id, "deploying");
    }
    const job = this.runDeploy(id, row.access, { pull: false });
    if (this.d.background === false) await job;
    else void job;
    return { restarting: true };
  }

  /** Run one console command inside the game's container (for example RCON). The command is a single argument, never shell text. */
  async runConsole(id: string, command: string): Promise<{ output: string; exitCode: number | null }> {
    const row = this.row(id);
    const tpl = this.template(row.templateId);
    if (!tpl.console) throw new UserError("This game has no console", 404);
    const cmd = command.trim();
    if (!cmd || cmd.length > 500 || /[\u0000-\u001f]/.test(cmd)) throw new UserError("Type a command (up to 500 characters, one line)");
    if (!row.containerId || (await this.d.docker.state(row.containerId)) !== "running") throw new UserError("Start the server first", 409);
    try {
      const r = await this.d.docker.exec(row.containerId, [...tpl.console.exec, cmd], { timeoutMs: 15_000 });
      this.event(id, "info", `Console: ${cmd.slice(0, 80)}`);
      return { output: r.output.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "").trim(), exitCode: r.exitCode };
    } catch (e) {
      throw new UserError(`The command did not run: ${e instanceof Error ? e.message : String(e)}`, 502);
    }
  }

  // ------------------------------------------------- restarts, updates, ports

  private careStoreInst?: CareStore;
  private careStore() {
    return (this.careStoreInst ??= new CareStore(this.d.db));
  }

  /** The image a server runs: the one it was moved to by an update, otherwise the template's. */
  private imageFor(row: typeof schema.servers.$inferSelect): string {
    return this.careStore().state(row.id).image ?? this.template(row.templateId).image;
  }

  /** Everything the server page needs for the restart, update and port sections. */
  careInfo(id: string) {
    const row = this.row(id);
    const tpl = this.template(row.templateId);
    const state = this.careStore().state(id);
    const image = this.imageFor(row);
    return {
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      settings: this.careStore().settings(id),
      canWarn: Boolean(tpl.console?.broadcast),
      lastRestartOn: state.lastRestartOn,
      image: { name: image, tag: tagOf(image), pinned: Boolean(tpl.versionPattern), moved: state.image !== null },
      update: state.check,
      portsEditable: !isCustomId(tpl.id),
    };
  }

  setCare(id: string, input: unknown): CareSettings {
    const row = this.row(id);
    let next: CareSettings;
    try {
      next = this.careStore().setSettings(id, input);
    } catch (e) {
      throw new UserError((e as Error).message, 400);
    }
    this.event(row.id, "info", `Upkeep schedule changed (restart ${next.restart.enabled ? `daily at ${next.restart.time}` : "off"}, automatic update ${next.update.auto ? `daily at ${next.update.time}` : "off"})`);
    return next;
  }

  /** Say something to the players in the game. Returns false when the game has no way to (or it failed). */
  private async broadcast(row: typeof schema.servers.$inferSelect, message: string): Promise<boolean> {
    const tpl = this.template(row.templateId);
    const b = tpl.console?.broadcast;
    if (!b || !tpl.console || !row.containerId) return false;
    const text = b.command.replace("${MESSAGE}", b.spaceChar ? message.replace(/ /g, b.spaceChar) : message);
    try {
      await this.d.docker.exec(row.containerId, [...tpl.console.exec, text], { timeoutMs: 15_000 });
      return true;
    } catch (e) {
      this.event(row.id, "warn", `Could not warn the players: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }

  /**
   * Look for a newer version. A game that lists version tags (a pinned template) is compared by tag, which downloads
   * nothing. Anything else is pulled, and counts as newer when the tag now points at a different image than the
   * one the server was created from.
   */
  async checkUpdate(id: string, now = new Date()): Promise<UpdateCheck> {
    const row = this.row(id);
    const tpl = this.template(row.templateId);
    if (!row.containerId) throw new UserError("Server has no container yet", 409);
    const image = this.imageFor(row);
    const checkedAt = now.toISOString();
    let check: UpdateCheck;
    if (tpl.versionPattern && isDockerHubImage(image)) {
      const current = tagOf(image);
      let tags: string[];
      try {
        tags = await (this.d.tagLister ?? dockerHubTags)(repoOf(image));
      } catch (e) {
        throw new UserError(`Could not look up versions on Docker Hub: ${e instanceof Error ? e.message : String(e)}`, 502);
      }
      const newest = newestTag(tags, tpl.versionPattern);
      const available = newest !== null && compareVersions(newest, current) > 0;
      check = {
        checkedAt,
        available,
        via: "tag",
        current,
        latest: available ? newest : null,
        note: available ? `Version ${newest} is out. This server runs ${current}.` : newest ? `Up to date: ${current} is the newest version.` : "No version tags were found, so nothing could be compared.",
      };
    } else {
      let fromRegistry: boolean;
      try {
        fromRegistry = await this.d.docker.pullImage(image);
      } catch (e) {
        throw new UserError(`Could not download ${image}: ${e instanceof Error ? e.message : String(e)}`, 502);
      }
      if (!fromRegistry) throw new UserError(`Could not reach the image registry, so ${image} could not be checked`, 502);
      const [latest, mine] = await Promise.all([this.d.docker.imageId(image), this.d.docker.containerImageId(row.containerId)]);
      const available = Boolean(latest && mine && latest !== mine);
      check = {
        checkedAt,
        available,
        via: "image",
        current: tagOf(image),
        latest: null,
        note: available ? `A newer build of ${image} is ready. The server is still running the old one.` : `Up to date: this server runs the newest build of ${image}.`,
      };
    }
    this.careStore().patchState(id, { check });
    this.event(id, "info", `Update check: ${check.note}`);
    return check;
  }

  /**
   * Switch to the newer version found by the last check. A backup is taken first (and nothing changes if it fails),
   * then the container is recreated from the new image. World data is kept.
   */
  async applyUpdate(id: string): Promise<{ restarting: boolean }> {
    const row = this.row(id);
    if (row.status === "deploying" || row.status === "updating") throw new UserError("Wait for the server to finish starting before updating it", 409);
    const check = this.careStore().state(id).check;
    if (!check?.available) throw new UserError("There is no update to apply. Check for an update first.", 409);
    const image = check.via === "tag" ? `${repoOf(this.imageFor(row))}:${check.latest}` : this.imageFor(row);
    if (existsSync(path.join(this.d.config.GAMESERVERS_DIR, row.slug))) {
      try {
        await this.backup(id);
      } catch (e) {
        throw new UserError(`Could not make a backup first, so nothing was changed: ${(e as Error).message}`, 500);
      }
    }
    this.event(id, "info", `Updating to ${check.via === "tag" ? check.latest : "the newest build"}; recreating the container (world data is kept, a backup was just made)`);
    this.setStatus(id, "updating");
    if (row.containerId) {
      try {
        await this.d.docker.remove(row.containerId);
      } catch (e) {
        this.setStatus(id, row.status, null);
        throw new UserError(`Could not stop the old container: ${e instanceof Error ? e.message : String(e)}`, 502);
      }
    }
    this.careStore().patchState(id, { image: check.via === "tag" ? image : this.careStore().state(id).image, check: null });
    const job = this.runDeploy(id, row.access, { pull: true });
    if (this.d.background === false) await job;
    else void job;
    return { restarting: true };
  }

  /**
   * Move a server to another game port. The first port of the template is the one asked for; any others move by the same
   * amount, so a game's ports stay in step (Valheim's query port is the game port plus one).
   */
  async changePorts(id: string, gamePort: number): Promise<{ restarting: boolean }> {
    const row = this.row(id);
    const tpl = this.template(row.templateId);
    if (isCustomId(tpl.id)) throw new UserError("A custom image's ports are fixed by the image. Set it up again with the ports you want.", 409);
    if (row.status === "deploying" || row.status === "updating") throw new UserError("Wait for the server to finish starting before changing its ports", 409);
    if (!Number.isInteger(gamePort)) throw new UserError("Type a port number");
    const shift = gamePort - tpl.ports[0].default;
    const next: Allocation[] = tpl.ports.map((p) => ({ name: p.name, port: p.default + shift, protocol: p.protocol, env: p.env }));
    for (const a of next) {
      if (a.port < 1024 || a.port > 65535) throw new UserError(`Port ${a.port} is not valid (use 1024-65535)`);
    }
    const old = this.ports(id);
    if (next.every((a) => old.some((o) => o.name === a.name && o.port === a.port))) return { restarting: false };

    const own = new Set(old.map((o) => portKey(o.port, o.protocol)));
    const taken = new Set([...this.takenPorts()].filter((k) => !own.has(k)));
    const busy = new Set([...this.busyPorts()].filter((k) => !own.has(k)));
    try {
      checkPorts(next, tpl.ports, taken, busy);
    } catch (e) {
      if (e instanceof Error && "conflicts" in e) {
        const pc = e as unknown as { conflicts: string[]; suggestion: Allocation[] | null };
        throw new UserError(e.message, 409, { conflicts: pc.conflicts, suggestion: pc.suggestion });
      }
      throw e;
    }

    this.setStatus(id, "updating");
    if (row.containerId) {
      try {
        await this.d.docker.remove(row.containerId);
      } catch (e) {
        this.setStatus(id, row.status, null);
        throw new UserError(`Could not stop the old container: ${e instanceof Error ? e.message : String(e)}`, 502);
      }
    }
    if (row.access === "public") {
      for (const p of old) {
        try {
          await this.d.connectivity.ensureClosed(id, row.slug, p.port, p.protocol);
        } catch (e) {
          this.event(id, "warn", `Could not close ${p.port}/${p.protocol} on the router: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
    this.d.db.transaction((tx) => {
      tx.delete(schema.serverPorts).where(eq(schema.serverPorts.serverId, id)).run();
      for (const a of next) tx.insert(schema.serverPorts).values({ serverId: id, name: a.name, port: a.port, protocol: a.protocol }).run();
    });
    this.reach.delete(id);
    this.event(id, "info", `Ports changed to ${next.map((a) => `${a.port}/${a.protocol}`).join(", ")}; recreating the container (world data is kept)`);
    const job = this.runDeploy(id, row.access, { pull: false });
    if (this.d.background === false) await job;
    else void job;
    return { restarting: true };
  }

  /** Message ids already sent, so a minute is not warned about twice. */
  private warned = new Set<string>();

  /**
   * One pass of the upkeep schedule (the panel calls it every minute): warn players and restart servers whose daily
   * restart is due, apply updates for servers with automatic updates, and refresh the "newer version" marker for
   * games that list version tags. Returns what it did, for the log.
   */
  async runScheduledCare(now = new Date()): Promise<string[]> {
    const done: string[] = [];
    const store = this.careStore();
    const today = dayKey(now);
    for (const r of this.d.db.select().from(schema.servers).all()) {
      if (!r.containerId || ["deploying", "updating", "error"].includes(r.status)) continue;
      const settings = store.settings(r.id);
      const state = store.state(r.id);
      const tpl = this.d.templates.find((x) => x.id === r.templateId);

      let updated = false;
      if (settings.update.auto && dueStatus(settings.update.time, now, state.lastUpdateOn).now) {
        store.patchState(r.id, { lastUpdateOn: today });
        try {
          const check = await this.checkUpdate(r.id, now);
          if (check.available && r.status === "online") {
            await this.applyUpdate(r.id);
            done.push(`${r.slug}: updated`);
            updated = true;
          }
        } catch (e) {
          this.event(r.id, "error", `Automatic update failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      } else if (tpl?.versionPattern && !isCustomId(tpl.id)) {
        // The version marker: one cheap look-up every few hours, no download.
        const age = state.check ? now.getTime() - new Date(state.check.checkedAt).getTime() : Infinity;
        if (age > 6 * 3_600_000) await this.checkUpdate(r.id, now).catch(() => undefined);
      }

      if (!settings.restart.enabled) continue;
      const due = dueStatus(settings.restart.time, now, state.lastRestartOn);
      const warn = settings.restart.warnMinutes;
      if (due.minutesLeft !== null && warn > 0 && r.status === "online" && (due.minutesLeft === warn || due.minutesLeft === 1)) {
        const key = `${r.id}:${today}:${due.minutesLeft}`;
        if (!this.warned.has(key)) {
          this.warned.add(key);
          if (this.warned.size > 500) this.warned.clear();
          const m = due.minutesLeft;
          if (await this.broadcast(r, `Server restarting in ${m} minute${m === 1 ? "" : "s"}.`)) this.event(r.id, "info", `Warned the players: restarting in ${m} minute${m === 1 ? "" : "s"}`);
        }
      }
      if (due.now) {
        store.patchState(r.id, { lastRestartOn: today });
        if (updated || r.status !== "online") continue; // a fresh update already restarted it; a stopped server stays stopped
        try {
          await this.restart(r.id);
          this.event(r.id, "info", `Scheduled restart (daily at ${settings.restart.time})`);
          done.push(`${r.slug}: restarted`);
        } catch (e) {
          this.event(r.id, "error", `Scheduled restart failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
    return done;
  }

  // --------------------------------------------------------------- backups

  private backups?: BackupStore;
  private busyBackups = new Set<string>();

  private store() {
    return (this.backups ??= new BackupStore(this.d.config.GAMESERVERS_DIR, this.d.config.BACKUP_KEEP, (slug) => this.backupExclude(slug)));
  }

  /** What the server's template says backups leave out. Works for a deleted server too, through the meta kept beside its backups. */
  private backupExclude(slug: string): string[] {
    const row = this.d.db.select().from(schema.servers).where(eq(schema.servers.slug, slug)).get();
    const templateId = row?.templateId ?? this.backups?.meta(slug)?.templateId;
    return this.d.templates.find((x) => x.id === templateId)?.backup.exclude ?? [];
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

  /** Keep what is needed to set a server up again beside its backups, so it survives the server being deleted. Only for servers that have backups. */
  private saveBackupMeta(row: typeof schema.servers.$inferSelect) {
    try {
      if (this.store().list(row.slug).length === 0) return;
      this.store().setMeta(row.slug, { name: row.name, templateId: row.templateId, env: row.env, access: row.access });
    } catch (e) {
      this.event(row.id, "warn", `Could not save the server's settings next to its backups: ${(e as Error).message}`);
    }
  }

  /** Every server's backups, including those of servers that have since been deleted. */
  allBackups(): BackupGroup[] {
    const store = this.store();
    const rows = this.d.db.select().from(schema.servers).all();
    const bySlug = new Map(rows.map((r) => [r.slug, r]));
    const slugs = [...new Set([...rows.map((r) => r.slug), ...store.slugs()])];
    const groups: BackupGroup[] = [];
    for (const slug of slugs) {
      const row = bySlug.get(slug);
      const backups = store.list(slug);
      if (!row && backups.length === 0) continue;
      const meta = store.meta(slug);
      const tpl = this.d.templates.find((x) => x.id === (row?.templateId ?? meta?.templateId));
      const secretKeys = new Set(tpl ? Object.entries(tpl.env).filter(([, v]) => v.secret).map(([k]) => k) : []);
      groups.push({
        slug,
        name: row?.name ?? meta?.name ?? slug,
        deleted: !row,
        serverId: row?.id ?? null,
        status: row?.status ?? null,
        templateId: tpl?.id ?? null,
        templateName: tpl?.name ?? null,
        backups,
        totalBytes: backups.reduce((n, b) => n + b.sizeBytes, 0),
        saved: meta
          ? {
              name: meta.name,
              templateId: this.d.templates.some((x) => x.id === meta.templateId) ? meta.templateId : null,
              env: Object.fromEntries(Object.entries(meta.env).filter(([k]) => !secretKeys.has(k))),
              savedSecrets: Object.keys(meta.env).filter((k) => secretKeys.has(k) && meta.env[k]),
              access: meta.access,
            }
          : null,
      });
    }
    return groups.sort((a, b) => Number(a.deleted) - Number(b.deleted) || (b.backups[0]?.createdAt ?? "").localeCompare(a.backups[0]?.createdAt ?? "") || a.name.localeCompare(b.name));
  }

  /** Delete one backup by server name, for servers that no longer exist as well as current ones. */
  deleteBackupBySlug(slug: string, name: string) {
    try {
      this.store().remove(slug, name);
    } catch (e) {
      throw new UserError((e as Error).message, 404);
    }
  }

  /**
   * Set a deleted server up again from one of its backups: same game, the saved settings (passwords included unless
   * replaced), and its world put in place before the first start. Settings that were not saved come from the request or the template's defaults.
   */
  async redeployFromBackup(slug: string, backupName: string, req: { name?: string; templateId?: string; env?: Record<string, string>; access?: "private" | "public" } = {}): Promise<string> {
    if (this.d.db.select().from(schema.servers).where(eq(schema.servers.slug, slug)).get()) throw new UserError("That server still exists. Use Restore on it instead.", 409);
    if (!this.store().list(slug).some((b) => b.name === backupName)) throw new UserError("Backup not found", 404);
    const meta = this.store().meta(slug);
    const templateId = req.templateId || meta?.templateId;
    const tpl = templateId ? this.d.templates.find((x) => x.id === templateId) : undefined;
    if (!tpl) throw new UserError("Choose which game this backup belongs to", 400, { field: "templateId" });
    const saved = meta?.templateId === tpl.id ? meta.env : {};
    const env: Record<string, string> = {};
    for (const key of Object.keys(tpl.env)) {
      const v = req.env?.[key]?.trim() || saved[key];
      if (v) env[key] = v;
    }
    return this.deploy({ templateId: tpl.id, name: req.name?.trim() || meta?.name || slug, env, access: req.access ?? "private", restoreFrom: { slug, name: backupName } });
  }

  listBackups(id: string): BackupInfo[] {
    return this.store().list(this.row(id).slug);
  }

  /** Back up while the server keeps running. For a fully consistent copy, stop the server first. */
  async backup(id: string): Promise<BackupInfo> {
    const row = this.row(id);
    return this.exclusive(row.slug, async () => {
      const info = await this.store().create(row.slug);
      this.saveBackupMeta(row);
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

  // ------------------------------------------------- outside port check

  private reach = new Map<string, Reachability>();

  /** Whether the Run button works, and who would be asked. */
  portCheckInfo() {
    return { enabled: Boolean(this.d.portProbe), via: this.d.portProbe?.name ?? null };
  }

  /**
   * Ask an outside service whether each public server's TCP ports answer. UDP has no handshake to test, so for UDP the panel
   * reports what it does know: whether the router is forwarding the port. Nothing here claims more than was actually checked.
   */
  async checkReachability(serverId?: string): Promise<{ via: string; checkedAt: string; results: ReachItem[] }> {
    const probe = this.d.portProbe;
    if (!probe) throw new UserError("The outside port check is turned off (PORT_CHECK=off)", 409);
    let rows = this.d.db.select().from(schema.servers).all();
    if (serverId) {
      const one = rows.find((r) => r.id === serverId);
      if (!one) throw new UserError("Server not found", 404);
      if (one.access !== "public") throw new UserError("Make the server public first", 409);
      rows = [one];
    } else {
      rows = rows.filter((r) => r.access === "public");
    }
    const checkedAt = new Date().toISOString();
    if (rows.length === 0) return { via: probe.name, checkedAt, results: [] };

    let ip: string;
    try {
      ip = await this.d.connectivity.externalIp();
    } catch (e) {
      throw new UserError(`Could not find your public IP, so there is nothing to check: ${e instanceof Error ? e.message : String(e)}`, 502);
    }
    let mappings: Awaited<ReturnType<ConnectivityProvider["list"]>> = [];
    if (this.d.connectivity.kind === "upnp") mappings = await this.d.connectivity.list().catch(() => []);
    const confirmed = new Set(
      this.d.db.select().from(schema.manualRules).all().filter((x) => x.confirmed).map((x) => `${x.serverId}:${x.port}/${x.protocol}`),
    );

    const results: ReachItem[] = [];
    for (const r of rows) {
      const ports = this.ports(r.id);
      const item = (p: { port: number; protocol: "tcp" | "udp" }, state: ReachState, detail: string): ReachItem => ({ serverId: r.id, name: r.name, port: p.port, protocol: p.protocol, state, detail });
      const mine: ReachItem[] = [];
      if (r.status === "offline" || r.status === "paused") {
        mine.push(item(ports[0] ?? { port: 0, protocol: "tcp" }, "stopped", "The server is stopped, so there is nothing to test"));
      } else {
        for (const p of ports) {
          if (p.protocol === "tcp") {
            const res = await probe.check(ip, p.port);
            mine.push(item(p, res.state, res.detail));
          } else {
            const fwd =
              this.d.connectivity.kind === "upnp" ? mappings.some((m) => m.port === p.port && m.protocol === "udp") : confirmed.has(`${r.id}:${p.port}/udp`);
            mine.push(item(p, fwd ? "forwarded" : "not-forwarded", fwd ? "The router forwards this port. UDP can't be tested from outside, so a player joining is the real test" : "The router is not forwarding this port"));
          }
        }
      }
      if (!mine.some((i) => i.state === "stopped")) this.reach.set(r.id, summarize(mine, checkedAt));
      results.push(...mine);
    }
    this.event(null, "info", `Outside port check run for ${rows.length} server${rows.length === 1 ? "" : "s"} via ${probe.name}`);
    return { via: probe.name, checkedAt, results };
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
      portCheck: this.portCheckInfo(),
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
