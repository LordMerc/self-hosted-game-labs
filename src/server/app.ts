import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { isCustomId } from "./servers/custom.js";
import { z } from "zod";
import { parseTrustProxy, type Config } from "./config.js";
import type { Db } from "./db/index.js";
import type { GameTemplate } from "../shared/template.js";
import type { ContainerDriver } from "./docker/driver.js";
import { ServerService, UserError } from "./servers/service.js";
import { CloudflareClient } from "./dns/cloudflare.js";
import type { DnsSettings } from "./dns/settings.js";
import { NOTIFY_KINDS, WebhookDeliveryError, WebhookError, type Notifier } from "./notifications/notifier.js";
import { hasAdminPassword, setAdminPassword, verifyAdminPassword } from "./auth/password.js";
import { LoginGuard, visitorKey, type LoginGuardOptions } from "./auth/rate-limit.js";
import { runningVersion, UpdateChecker } from "./updates.js";
import { HostStats } from "./host-stats.js";
import { settingsPeakStore, StatsHistory } from "./history.js";
import { DEFAULT_INSTANCE, names } from "./instance.js";

const ARTWORK_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };
const SESSION_COOKIE = "gl_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface AppDeps {
  config: Config;
  db: Db;
  templates: GameTemplate[];
  service: ServerService;
  docker: ContainerDriver;
  dnsSettings: DnsSettings;
  notifier: Notifier;
  /** Injectable for tests. */
  inspectToken?: typeof CloudflareClient.inspect;
  hostStats?: HostStats;
  /** The short in-memory record behind the dashboard's charts. index.ts adds a sample every few seconds. */
  history?: StatsHistory;
  webRoot?: string;
  /** Injectable for tests. */
  updates?: UpdateChecker;
  loginGuard?: LoginGuardOptions;
}

const passwordBody = z.object({ password: z.string().min(1) });
const newPasswordBody = z.object({ password: z.string().min(10, "Use at least 10 characters") });

export function buildApp({ config, db, templates, service, docker, dnsSettings, notifier, inspectToken = CloudflareClient.inspect, hostStats = new HostStats([config.GAMESERVERS_DIR, config.DATA_DIR]), history = new StatsHistory({ store: settingsPeakStore(db) }), webRoot, updates = new UpdateChecker(db, { current: runningVersion(config.APP_VERSION), envEnabled: config.UPDATE_CHECK === "on" }), loginGuard }: AppDeps): FastifyInstance {
  // Behind a reverse proxy the connection comes from the proxy; TRUST_PROXY says whose word to take for the visitor's address and HTTPS.
  const app = Fastify({ logger: false, trustProxy: parseTrustProxy(config.TRUST_PROXY) });
  const guard = new LoginGuard(loginGuard);

  app.register(cookie, { secret: config.SESSION_SECRET });

  // Headers that cost nothing and close off framing, sniffing and caching of API answers.
  app.addHook("onSend", async (req, reply) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-frame-options", "DENY");
    reply.header("referrer-policy", "no-referrer");
    reply.header("content-security-policy", "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (req.url.startsWith("/api/")) reply.header("cache-control", "no-store");
    // Only meaningful (and only honoured by browsers) over HTTPS; tells the browser never to try plain HTTP for this name again.
    if (req.protocol === "https" && config.COOKIE_SECURE !== "never") reply.header("strict-transport-security", "max-age=15552000");
  });

  const cookieSecure = config.COOKIE_SECURE === "auto" ? ("auto" as const) : config.COOKIE_SECURE === "always";
  const startSession = (reply: import("fastify").FastifyReply) =>
    reply.setCookie(SESSION_COOKIE, String(Date.now() + SESSION_TTL_MS), {
      path: "/",
      httpOnly: true,
      sameSite: "strict",
      secure: cookieSecure,
      signed: true,
      maxAge: SESSION_TTL_MS / 1000,
    });

  const isAuthed = (req: import("fastify").FastifyRequest): boolean => {
    const raw = req.cookies[SESSION_COOKIE];
    if (!raw) return false;
    const res = req.unsignCookie(raw);
    return res.valid && Number(res.value) > Date.now();
  };

  // Everything under /api requires a session except health and the auth endpoints.
  app.addHook("onRequest", async (req, reply) => {
    const url = req.url.split("?")[0];
    if (!url.startsWith("/api/") || url === "/api/health" || url.startsWith("/api/auth/")) return;
    if (!isAuthed(req)) return reply.code(401).send({ error: "unauthorized" });
  });

  // `build` is when this build was produced, so it is easy to tell whether a redeploy picked up new code.
  const build = (() => {
    try {
      return statSync(new URL(import.meta.url)).mtime.toISOString();
    } catch {
      return null;
    }
  })();
  app.get("/api/health", async () => ({ status: "ok", build }));

  app.get("/api/auth/status", async (req) => ({
    setupRequired: !hasAdminPassword(db),
    authenticated: isAuthed(req),
    /** Only set when this is not the default panel, so the page can say which copy you are looking at. */
    instance: names.instance === DEFAULT_INSTANCE ? null : names.instance,
  }));

  app.post("/api/auth/setup", async (req, reply) => {
    if (hasAdminPassword(db)) return reply.code(409).send({ error: "already configured" });
    const body = newPasswordBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues[0].message });
    await setAdminPassword(db, body.data.password);
    startSession(reply);
    return { ok: true };
  });

  app.post("/api/auth/login", async (req, reply) => {
    const visitor = visitorKey(req.ip);
    const verdict = guard.check(visitor);
    if (!verdict.allowed) {
      const minutes = Math.ceil(verdict.retryAfterSec / 60);
      const wait = minutes <= 1 ? "a minute" : `${minutes} minutes`;
      reply.header("retry-after", String(verdict.retryAfterSec));
      return reply.code(429).send({
        error: verdict.scope === "visitor" ? `Too many wrong passwords. Try again in ${wait}.` : `Sign-in is paused for ${wait} because of many failed attempts from different places.`,
      });
    }
    const body = passwordBody.safeParse(req.body);
    if (!body.success || !(await verifyAdminPassword(db, body.data.password))) {
      guard.fail(visitor);
      return reply.code(401).send({ error: "incorrect password" });
    }
    guard.succeed(visitor);
    startSession(reply);
    return { ok: true };
  });

  app.post("/api/auth/logout", async (_req, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.setErrorHandler((err: unknown, _req, reply) => {
    if (err instanceof UserError) return reply.code(err.status).send({ error: err.message, ...err.extra });
    const e = err as { statusCode?: number; message?: string };
    if (e.statusCode && e.statusCode < 500) return reply.code(e.statusCode).send({ error: e.message });
    app.log.error(err);
    return reply.code(500).send({ error: "internal error" });
  });

  const idParam = (req: { params: unknown }) => (req.params as { id: string }).id;

  app.get("/api/templates", async () =>
    templates.filter((t) => !isCustomId(t.id)).map(({ id, name, image, maxPlayers, notes, resources, join, ports, env, accent, artwork, playerCount }) => ({
      id,
      accent: accent ?? null,
      artwork: artwork && existsSync(path.join(config.TEMPLATES_DIR, artwork)) ? `/api/templates/${id}/artwork` : null,
      name,
      image,
      maxPlayers,
      /** Whether the panel can read this game's live player count; false means it never will, so the page says so. */
      reportsPlayers: Boolean(playerCount) || ports.some((p) => p.query !== "none"),
      notes,
      minMemoryMb: resources.minMemoryMb ?? null,
      join,
      ports,
      env: Object.entries(env).map(([key, v]) => ({ key, ...v })),
    })),
  );

  /** Optional picture a template ships for its card. Only files inside the templates folder, with an image extension, are served. */
  app.get("/api/templates/:id/artwork", async (req, reply) => {
    const t = templates.find((x) => x.id === idParam(req));
    const root = path.resolve(config.TEMPLATES_DIR);
    const file = t?.artwork ? path.resolve(root, t.artwork) : null;
    const type = file ? ARTWORK_TYPES[path.extname(file).toLowerCase()] : undefined;
    if (!file || !type || !file.startsWith(root + path.sep) || !existsSync(file)) return reply.code(404).send({ error: "no artwork" });
    return reply.header("cache-control", "public, max-age=3600").type(type).send(readFileSync(file));
  });

  app.get("/api/templates/:id/plan", async (req) => ({ ports: service.planPorts(idParam(req)) }));

  app.get("/api/servers", async () => service.list());

  /** Game servers run by a different panel instance on this host: listed so you can see them, never changed from here. */
  app.get("/api/other-panels", async () => docker.listOtherPanels().catch(() => []));

  /** Host figures and per-server usage for the dashboard. Players are not reported yet. */
  app.get("/api/stats", async () => ({
    host: hostStats.snapshot(),
    servers: await service.usage(),
    history: history.view(),
    docker: (await docker.info?.().catch(() => null)) ?? null,
  }));

  /** The latest things that happened across all servers, for the dashboard's activity list. */
  app.get("/api/activity", async () => service.recentActivity(6));

  const deployBody = z.object({
    templateId: z.string(),
    name: z.string(),
    env: z.record(z.string(), z.string()).optional(),
    ports: z.record(z.string(), z.number()).optional(),
    access: z.enum(["private", "public"]).optional(),
    cpus: z.number().nullable().optional(),
    memoryMb: z.number().nullable().optional(),
  });
  app.post("/api/servers", async (req, reply) => {
    const body = deployBody.safeParse(req.body);
    if (!body.success) throw new UserError(body.error.issues[0].message);
    const id = await service.deploy(body.data);
    return reply.code(202).send({ id });
  });

  const customBody = z.object({
    name: z.string(),
    image: z.string().trim(),
    ports: z.array(z.object({ port: z.number(), protocol: z.enum(["tcp", "udp"]) })),
    env: z.record(z.string(), z.string()).optional(),
    dataPath: z.string().trim().optional(),
    dataOwner: z.string().trim().optional(),
    access: z.enum(["private", "public"]).optional(),
    cpus: z.number().nullable().optional(),
    memoryMb: z.number().nullable().optional(),
  });
  app.post("/api/servers/custom", async (req, reply) => {
    const body = customBody.safeParse(req.body);
    if (!body.success) throw new UserError("Fill in a name, an image and at least one port");
    const id = await service.deployCustom(body.data);
    return reply.code(202).send({ id });
  });

  for (const action of ["start", "stop", "restart", "retry"] as const) {
    app.post(`/api/servers/:id/${action}`, async (req) => {
      await service[action](idParam(req));
      return { ok: true };
    });
  }

  app.put("/api/servers/:id/access", async (req) => {
    const body = z.object({ access: z.enum(["private", "public"]) }).safeParse(req.body);
    if (!body.success) throw new UserError("access must be private or public");
    await service.setAccess(idParam(req), body.data.access);
    return { ok: true };
  });

  app.delete("/api/servers/:id", async (req) => {
    const q = z.object({ deleteData: z.enum(["true", "false"]).optional(), confirmName: z.string().optional() }).parse(req.query);
    return service.remove(idParam(req), { deleteData: q.deleteData === "true", confirmName: q.confirmName });
  });

  app.get("/api/backups", async () => service.allBackups());
  app.delete("/api/backups/:slug/:name", async (req) => {
    const { slug, name } = req.params as { slug: string; name: string };
    service.deleteBackupBySlug(slug, name);
    return { ok: true };
  });
  const redeployBody = z.object({
    name: z.string().optional(),
    templateId: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
    access: z.enum(["private", "public"]).optional(),
  });
  app.post("/api/backups/:slug/:name/redeploy", async (req, reply) => {
    const { slug, name } = req.params as { slug: string; name: string };
    const body = redeployBody.safeParse(req.body ?? {});
    if (!body.success) throw new UserError(body.error.issues[0].message);
    const id = await service.redeployFromBackup(slug, name, body.data);
    return reply.code(202).send({ id });
  });

  app.get("/api/servers/:id", async (req) => service.detail(idParam(req)));
  app.put("/api/servers/:id/settings", async (req, reply) => {
    const body = z.object({ name: z.string().optional(), env: z.record(z.string(), z.string()).optional(), cpus: z.number().nullable().optional(), memoryMb: z.number().nullable().optional() }).safeParse(req.body);
    if (!body.success) throw new UserError(body.error.issues[0].message);
    const r = await service.updateSettings(idParam(req), body.data);
    return reply.code(r.restarting ? 202 : 200).send(r);
  });
  app.post("/api/servers/:id/apply", async (req, reply) => reply.code(202).send(await service.applySettings(idParam(req))));
  app.put("/api/servers/:id/care", async (req) => service.setCare(idParam(req), req.body));
  app.post("/api/servers/:id/update/check", async (req) => service.checkUpdate(idParam(req)));
  app.post("/api/servers/:id/update/apply", async (req, reply) => reply.code(202).send(await service.applyUpdate(idParam(req))));
  app.put("/api/servers/:id/ports", async (req, reply) => {
    const body = z.object({ port: z.number() }).safeParse(req.body);
    if (!body.success) throw new UserError("Type a port number");
    const r = await service.changePorts(idParam(req), body.data.port);
    return reply.code(r.restarting ? 202 : 200).send(r);
  });
  app.post("/api/servers/:id/console", async (req) => {
    const body = z.object({ command: z.string() }).safeParse(req.body);
    if (!body.success) throw new UserError("command is required");
    return service.runConsole(idParam(req), body.data.command);
  });

  app.get("/api/servers/:id/backups", async (req) => service.listBackups(idParam(req)));
  app.get("/api/servers/:id/backups/settings", async (req) => service.backupSettings(idParam(req)));
  app.put("/api/servers/:id/backups/settings", async (req) => service.setBackupSettings(idParam(req), req.body));
  app.post("/api/servers/:id/backups", async (req) => service.backup(idParam(req)));
  app.post("/api/servers/:id/backups/:name/restore", async (req) => {
    await service.restoreBackup(idParam(req), (req.params as { name: string }).name);
    return { ok: true };
  });
  app.delete("/api/servers/:id/backups/:name", async (req) => {
    service.deleteBackup(idParam(req), (req.params as { name: string }).name);
    return { ok: true };
  });

  app.get("/api/servers/:id/secrets/:key", async (req) => {
    const { id, key } = req.params as { id: string; key: string };
    return { value: service.secret(id, key) };
  });

  app.get("/api/servers/:id/events", async (req) => service.events(idParam(req)));

  app.get("/api/servers/:id/logs", async (req, reply) => {
    const row = service.getRow(idParam(req));
    if (!row.containerId) throw new UserError("Server has no container yet", 409);
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    const ac = new AbortController();
    req.raw.on("close", () => ac.abort());
    await docker
      .streamLogs(row.containerId, (line) => res.write(`data: ${JSON.stringify(line)}\n\n`), ac.signal)
      .catch(() => undefined);
    res.end();
  });

  app.get("/api/settings/dns", async () => dnsSettings.status());

  // Check a pasted token and list the domains it can see, so the user can pick one.
  app.post("/api/settings/dns/check", async (req) => {
    const body = z.object({ token: z.string().optional() }).safeParse(req.body);
    const token = body.success ? body.data.token?.trim() : undefined;
    if (!token) throw new UserError("Paste your Cloudflare API token");
    return inspectToken(token);
  });

  app.put("/api/settings/dns", async (req) => {
    const body = z.object({ token: z.string().optional(), zone: z.string(), host: z.string() }).safeParse(req.body);
    if (!body.success) throw new UserError("Choose a domain and a hostname");
    if (dnsSettings.status().source === "env") throw new UserError("DNS is set by environment variables (CF_API_TOKEN, CF_ZONE, PUBLIC_HOST). Remove them to manage it here.", 409);
    try {
      await dnsSettings.save(body.data);
    } catch (e) {
      throw new UserError(e instanceof Error ? e.message : String(e), 400);
    }
    // Point the name at the current IP right away; a failure here should not undo the save.
    const sync = await service.syncDdns().catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }));
    return { ok: true, sync };
  });

  app.delete("/api/settings/dns", async () => {
    if (dnsSettings.status().source === "env") throw new UserError("DNS is set by environment variables and can't be removed here", 409);
    dnsSettings.clear();
    return { ok: true };
  });

  // "New version available" notice. Reading this never touches the network; the daily check runs from index.ts.
  app.get("/api/updates", async () => updates.state());
  app.put("/api/updates/settings", async (req) => {
    const body = z.object({ enabled: z.boolean() }).safeParse(req.body);
    if (!body.success) throw new UserError("enabled must be true or false");
    if (config.UPDATE_CHECK === "off") throw new UserError("Update checks are turned off by the UPDATE_CHECK environment variable.", 409);
    updates.setEnabled(body.data.enabled);
    if (body.data.enabled) await updates.checkIfDue();
    return updates.state();
  });
  app.post("/api/updates/check", async () => {
    const ran = await updates.checkNow();
    return { ran, ...updates.state() };
  });

  app.get("/api/settings/notifications", async () => notifier.status());

  const notifyEvents = z.object(Object.fromEntries(NOTIFY_KINDS.map((k) => [k, z.boolean().optional()])) as Record<(typeof NOTIFY_KINDS)[number], z.ZodOptional<z.ZodBoolean>>);
  app.put("/api/settings/notifications", async (req) => {
    const body = z.object({ url: z.string().optional(), events: notifyEvents.optional() }).safeParse(req.body);
    if (!body.success) throw new UserError("The notification settings were not understood");
    try {
      notifier.save(body.data);
    } catch (e) {
      if (e instanceof WebhookError) throw new UserError(e.message);
      throw e;
    }
    return notifier.status();
  });

  // Sends one message to the pasted address (or the saved one) so the person sees it arrive before relying on it.
  app.post("/api/settings/notifications/test", async (req) => {
    const body = z.object({ url: z.string().optional() }).safeParse(req.body ?? {});
    try {
      await notifier.sendTest(body.success ? body.data.url : undefined);
    } catch (e) {
      if (e instanceof WebhookError) throw new UserError(e.message, e instanceof WebhookDeliveryError ? 502 : 400);
      throw e;
    }
    return { ok: true };
  });

  app.delete("/api/settings/notifications", async () => {
    notifier.clear();
    return { ok: true };
  });

  app.get("/api/network/diagnostics", async () => service.diagnostics());

  app.get("/api/network", async () => service.network());

  app.post("/api/network/port-check", async (req) => {
    const body = z.object({ serverId: z.string().optional() }).safeParse(req.body ?? {});
    if (!body.success) throw new UserError("serverId must be text");
    return service.checkReachability(body.data.serverId);
  });

  app.put("/api/network/rules/:id", async (req) => {
    const body = z.object({ confirmed: z.boolean() }).safeParse(req.body);
    if (!body.success) throw new UserError("confirmed must be true or false");
    service.confirmRule(Number(idParam(req)), body.data.confirmed);
    return { ok: true };
  });

  app.post("/api/network/ddns", async () => {
    try {
      return (await service.syncDdns()) ?? { skipped: "Cloudflare is not configured" };
    } catch (e) {
      throw new UserError(e instanceof Error ? e.message : String(e), 502);
    }
  });

  if (webRoot && existsSync(webRoot)) {
    app.register(fastifyStatic, { root: path.resolve(webRoot) });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/")) return reply.code(404).send({ error: "not found" });
      return reply.sendFile("index.html");
    });
  }

  return app;
}
