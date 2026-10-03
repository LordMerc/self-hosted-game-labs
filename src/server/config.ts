import { z } from "zod";

const schema = z.object({
  PANEL_PORT: z.coerce.number().int().min(1).max(65535).default(8090),
  DATA_DIR: z.string().default("/data"),
  GAMESERVERS_DIR: z.string().startsWith("/", "GAMESERVERS_DIR must be an absolute path").default("/srv/gameservers"),
  TEMPLATES_DIR: z.string().default("templates"),
  SESSION_SECRET: z.string().min(32, "SESSION_SECRET must be at least 32 characters"),
  PUBLIC_HOST: z.string().optional(),
  HOST_LAN_IP: z.string().optional(),
  CONNECTIVITY: z.enum(["manual", "upnp"]).default("manual"),
  CF_API_TOKEN: z.string().optional(),
  CF_ZONE: z.string().optional(),
  /** Override the "what is my IP" endpoint used when the router cannot tell us. */
  IP_ECHO_URL: z.string().url().default("https://api.ipify.org"),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  return parsed.data;
}
