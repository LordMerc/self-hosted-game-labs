import { sqliteTable, text, integer, real, uniqueIndex, primaryKey } from "drizzle-orm/sqlite-core";

/** `private`: home network only. `public`: reached directly (router rules, DNS). `relay`: reached through the playit.gg relay, so the home IP stays hidden. */
export type Access = "private" | "public" | "relay";

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const servers = sqliteTable(
  "servers",
  {
    id: text("id").primaryKey(),
    slug: text("slug").notNull().unique(),
    name: text("name").notNull(),
    templateId: text("template_id").notNull(),
    status: text("status", {
      enum: ["deploying", "online", "paused", "offline", "updating", "error"],
    })
      .notNull()
      .default("deploying"),
    access: text("access", { enum: ["private", "public", "relay"] }).notNull().default("private"),
    env: text("env", { mode: "json" }).$type<Record<string, string>>().notNull().default({}),
    containerId: text("container_id"),
    /** Most CPU cores the game may use; null = no limit. */
    cpus: real("cpus"),
    /** Most memory the game may use, in MB; null = no limit. */
    memoryMb: integer("memory_mb"),
    lastError: text("last_error"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
);

export const serverPorts = sqliteTable(
  "server_ports",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    serverId: text("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    port: integer("port").notNull(),
    protocol: text("protocol", { enum: ["tcp", "udp"] }).notNull(),
  },
  // Host ports equal container ports, so (port, protocol) is globally unique.
  (t) => [uniqueIndex("server_ports_port_proto").on(t.port, t.protocol)],
);

export const events = sqliteTable("events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  serverId: text("server_id"),
  level: text("level", { enum: ["info", "warn", "error"] }).notNull(),
  message: text("message").notNull(),
  at: integer("at", { mode: "timestamp" }).notNull(),
});

/** Router rules the user must add by hand when CONNECTIVITY=manual. */
export const manualRules = sqliteTable(
  "manual_rules",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    serverId: text("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    port: integer("port").notNull(),
    protocol: text("protocol", { enum: ["tcp", "udp"] }).notNull(),
    confirmed: integer("confirmed", { mode: "boolean" }).notNull().default(false),
  },
  (t) => [uniqueIndex("manual_rules_port_proto").on(t.port, t.protocol)],
);

/**
 * The last real answer of the outside port check, per server port, so it survives a panel restart. Only a definite answer
 * is kept (reachable, not reachable, or what the router forwards): a check that could not finish never overwrites it.
 */
export const portChecks = sqliteTable(
  "port_checks",
  {
    serverId: text("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    port: integer("port").notNull(),
    protocol: text("protocol", { enum: ["tcp", "udp"] }).notNull(),
    state: text("state", { enum: ["open", "closed", "forwarded", "not-forwarded"] }).notNull(),
    detail: text("detail").notNull(),
    checkedAt: integer("checked_at", { mode: "timestamp" }).notNull(),
    /** The public IP when the check ran, to tell later whether the answer is about a different address. */
    publicIp: text("public_ip"),
  },
  (t) => [primaryKey({ columns: [t.serverId, t.port, t.protocol] })],
);
