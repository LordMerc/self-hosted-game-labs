import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Config } from "./config.js";
import type { Db } from "./db/index.js";
import type { GameTemplate } from "../shared/template.js";
import type { ContainerDriver } from "./docker/driver.js";
import { ServerService, UserError } from "./servers/service.js";
import { hasAdminPassword, setAdminPassword, verifyAdminPassword } from "./auth/password.js";
import { LoginRateLimiter } from "./auth/rate-limit.js";

const SESSION_COOKIE = "gl_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface AppDeps {
  config: Config;
  db: Db;
  templates: GameTemplate[];
  service: ServerService;
  docker: ContainerDriver;
  webRoot?: string;
}

const passwordBody = z.object({ password: z.string().min(1) });
const newPasswordBody = z.object({ password: z.string().min(10, "Use at least 10 characters") });

export function buildApp({ config, db, templates, service, docker, webRoot }: AppDeps): FastifyInstance {
  const app = Fastify({ logger: false });
  const limiter = new LoginRateLimiter();

  app.register(cookie, { secret: config.SESSION_SECRET });

  const startSession = (reply: import("fastify").FastifyReply) =>
    reply.setCookie(SESSION_COOKIE, String(Date.now() + SESSION_TTL_MS), {
      path: "/",
      httpOnly: true,
      sameSite: "strict",
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
    if (!limiter.attempt(req.ip)) return reply.code(429).send({ error: "too many attempts, try again in a minute" });
    const body = passwordBody.safeParse(req.body);
    if (!body.success || !(await verifyAdminPassword(db, body.data.password))) {
      return reply.code(401).send({ error: "incorrect password" });
    }
    limiter.reset(req.ip);
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
    templates.map(({ id, name, image, maxPlayers, join, ports, env }) => ({
      id,
      name,
      image,
      maxPlayers,
      join,
      ports,
      env: Object.entries(env).map(([key, v]) => ({ key, ...v })),
    })),
  );

  app.get("/api/templates/:id/plan", async (req) => ({ ports: service.planPorts(idParam(req)) }));

  app.get("/api/servers", async () => service.list());

  const deployBody = z.object({
    templateId: z.string(),
    name: z.string(),
    env: z.record(z.string(), z.string()).optional(),
    ports: z.record(z.string(), z.number()).optional(),
    access: z.enum(["private", "public"]).optional(),
  });
  app.post("/api/servers", async (req, reply) => {
    const body = deployBody.safeParse(req.body);
    if (!body.success) throw new UserError(body.error.issues[0].message);
    const id = await service.deploy(body.data);
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

  app.get("/api/network", async () => service.network());

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
