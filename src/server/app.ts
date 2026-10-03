import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Config } from "./config.js";
import type { Db } from "./db/index.js";
import { schema } from "./db/index.js";
import type { GameTemplate } from "../shared/template.js";
import { hasAdminPassword, setAdminPassword, verifyAdminPassword } from "./auth/password.js";
import { LoginRateLimiter } from "./auth/rate-limit.js";

const SESSION_COOKIE = "gl_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface AppDeps {
  config: Config;
  db: Db;
  templates: GameTemplate[];
  webRoot?: string;
}

const passwordBody = z.object({ password: z.string().min(1) });
const newPasswordBody = z.object({ password: z.string().min(10, "Use at least 10 characters") });

export function buildApp({ config, db, templates, webRoot }: AppDeps): FastifyInstance {
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

  app.get("/api/health", async () => ({ status: "ok" }));

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

  app.get("/api/templates", async () => templates.map(({ id, name, image, maxPlayers, join, ports }) => ({ id, name, image, maxPlayers, join, ports })));

  app.get("/api/servers", async () => {
    const servers = db.select().from(schema.servers).all();
    const ports = db.select().from(schema.serverPorts).all();
    return servers.map(({ env: _env, ...s }) => ({ ...s, ports: ports.filter((p) => p.serverId === s.id) }));
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
