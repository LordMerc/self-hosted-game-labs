import { z } from "zod";

const slug = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "must be lowercase letters, digits and dashes");
const envName = z.string().regex(/^[A-Z_][A-Z0-9_]*$/, "must be an UPPER_SNAKE_CASE env var name");

const portSchema = z
  .object({
    name: z.string().min(1),
    default: z.number().int().min(1024).max(65535),
    protocol: z.enum(["tcp", "udp"]),
    /** Env var the game server reads its port from. Host port == container port == this value. */
    env: envName.optional(),
    query: z.enum(["none", "a2s", "minecraft"]).default("none"),
  })
  .strict();

const envVarSchema = z
  .object({
    label: z.string().min(1),
    default: z.string().optional(),
    required: z.boolean().default(false),
    secret: z.boolean().default(false),
    /** Generate a random value at deploy time when the user leaves it empty. */
    generate: z.boolean().default(false),
    help: z.string().optional(),
    /** The value must be one of these; the forms show a drop-down. */
    choices: z.array(z.string().min(1)).min(1).optional(),
    /** The value must match this regular expression (whole value). `patternMessage` is shown when it does not. */
    pattern: z.string().optional(),
    patternMessage: z.string().optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.pattern !== undefined) {
      try {
        new RegExp(`^(?:${v.pattern})$`);
      } catch {
        ctx.addIssue({ code: "custom", path: ["pattern"], message: "is not a valid regular expression" });
      }
    }
    if (v.default !== undefined && v.default !== "" && v.choices && !v.choices.includes(v.default)) {
      ctx.addIssue({ code: "custom", path: ["default"], message: "must be one of the choices" });
    }
  });

/** A path inside a server's data folder: plain names joined by slashes, no `..`. */
const relPath = z.string().regex(/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/, "must be a relative path of plain names").refine((p) => !p.split("/").some((x) => x === ".." || x === "."), "must not contain . or .. parts");

// `.strict()` everywhere: unknown keys (privileged, networkMode, binds, ...) are rejected rather than
// ignored, so a template can never smuggle in container options the panel does not deliberately support.
export const templateSchema = z
  .object({
    id: slug,
    name: z.string().min(1),
    image: z.string().min(1),
    maxPlayers: z.number().int().positive().optional(),
    /** Shown in the deploy form: what to know before starting (memory needs, first-run steps). */
    notes: z.string().optional(),
    join: z
      .object({
        method: z.enum(["direct", "server-browser"]).default("direct"),
        instructions: z.string().optional(),
      })
      .strict()
      .default({ method: "direct" }),
    ports: z.array(portSchema).min(1),
    env: z.record(envName, envVarSchema).default({}),
    /** A command box on the server page: each command is passed as one argument to this program inside the container (no shell). */
    console: z
      .object({
        exec: z.array(z.string().min(1)).min(1),
        examples: z.array(z.string()).default([]),
      })
      .strict()
      .optional(),
    /** Arguments passed to the image's own start-up command. `${NAME}` is replaced by that setting's value (a port's env name works too); an empty value drops the argument. */
    command: z.array(z.string()).optional(),
    /** Give the container a terminal. A few servers (Terraria) crash without one. */
    tty: z.boolean().default(false),
    /** Backups skip these paths (relative to the server's data folder), for big files that the game downloads again by itself. */
    backup: z.object({ exclude: z.array(relPath).default([]) }).strict().default({ exclude: [] }),
    data: z
      .array(
        z
          .object({
            containerPath: z.string().startsWith("/"),
            /** Owner the game runs as. The panel creates the folder as root, so for images that do not fix this themselves it sets it. */
            owner: z.object({ uid: z.number().int().min(0), gid: z.number().int().min(0) }).strict().optional(),
          })
          .strict(),
      )
      .default([]),
    readiness: z
      .object({ type: z.enum(["port-listening", "log-regex"]).default("port-listening"), pattern: z.string().optional() })
      .strict()
      .default({ type: "port-listening" }),
  })
  .strict()
  .superRefine((t, ctx) => {
    const seenNames = new Set<string>();
    const seenPorts = new Set<string>();
    const portEnvs = new Set<string>();
    t.ports.forEach((p, i) => {
      if (seenNames.has(p.name)) ctx.addIssue({ code: "custom", path: ["ports", i, "name"], message: `duplicate port name "${p.name}"` });
      seenNames.add(p.name);
      const key = `${p.default}/${p.protocol}`;
      if (seenPorts.has(key)) ctx.addIssue({ code: "custom", path: ["ports", i], message: `duplicate port ${key}` });
      seenPorts.add(key);
      if (p.env) portEnvs.add(p.env);
    });
    for (const name of Object.keys(t.env)) {
      if (portEnvs.has(name)) ctx.addIssue({ code: "custom", path: ["env", name], message: "is set from a port and cannot also be a user input" });
    }
    for (const [i, arg] of (t.command ?? []).entries()) {
      for (const m of arg.matchAll(/\$\{([A-Z_][A-Z0-9_]*)\}/g)) {
        if (!(m[1] in t.env) && !portEnvs.has(m[1])) ctx.addIssue({ code: "custom", path: ["command", i], message: `refers to unknown setting ${m[1]}` });
      }
    }
    if (t.join.method === "server-browser" && !t.join.instructions) {
      ctx.addIssue({ code: "custom", path: ["join", "instructions"], message: "required when join.method is server-browser" });
    }
    if (t.readiness.type === "log-regex" && !t.readiness.pattern) {
      ctx.addIssue({ code: "custom", path: ["readiness", "pattern"], message: "required when readiness.type is log-regex" });
    }
  });

export type GameTemplate = z.infer<typeof templateSchema>;
export type TemplatePort = GameTemplate["ports"][number];
