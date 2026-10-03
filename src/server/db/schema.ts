import { sqliteTable, text, integer, uniqueIndex } from "drizzle-orm/sqlite-core";

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
    access: text("access", { enum: ["private", "public"] }).notNull().default("private"),
    env: text("env", { mode: "json" }).$type<Record<string, string>>().notNull().default({}),
    containerId: text("container_id"),
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
