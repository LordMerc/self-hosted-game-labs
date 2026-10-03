import { z } from "zod";

const schema = z.object({
  PANEL_PORT: z.coerce.number().int().min(1).max(65535).default(8090),
  /** Address the panel listens on. 127.0.0.1 makes it reachable only from this machine (for a reverse proxy running on it). */
  PANEL_HOST: z.string().default("0.0.0.0"),
  DATA_DIR: z.string().default("/data"),
  GAMESERVERS_DIR: z.string().startsWith("/", "GAMESERVERS_DIR must be an absolute path").default("/srv/gameservers"),
  /** How many backups to keep per server; older ones are removed after each new backup. */
  BACKUP_KEEP: z.coerce.number().int().min(1).max(100).default(7),
  TEMPLATES_DIR: z.string().default("templates"),
  SESSION_SECRET: z.string().min(32, "SESSION_SECRET must be at least 32 characters"),
  PUBLIC_HOST: z.string().optional(),
  HOST_LAN_IP: z.string().optional(),
  CONNECTIVITY: z.enum(["manual", "upnp"]).default("manual"),
  /** "off" removes the Run button for the outside port check, which sends your public IP and a port to check-host.net. */
  PORT_CHECK: z.enum(["on", "off"]).default("on"),
  /**
   * Which proxies in front of the panel to believe about the visitor's address and whether they used HTTPS.
   * Empty means none (the safe default when the panel is reached directly). Otherwise "true"
   * or a comma-separated list of addresses, networks or the words loopback / linklocal / uniquelocal.
   */
  TRUST_PROXY: z.string().default(""),
  /** Mark the session cookie Secure: "auto" does so when the visit came in over HTTPS, "always" and "never" force it. */
  COOKIE_SECURE: z.enum(["auto", "always", "never"]).default("auto"),
  /** "off" stops the panel asking GitHub once a day whether a newer release exists. */
  UPDATE_CHECK: z.enum(["on", "off"]).default("on"),
  /** Set by the published image (a release number, or dev-<commit>); otherwise the version in package.json is used. */
  APP_VERSION: z.string().default(""),
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

/** Turn the TRUST_PROXY text into what Fastify expects. */
export function parseTrustProxy(value: string): boolean | string[] {
  const v = value.trim();
  if (!v || v.toLowerCase() === "false") return false;
  if (v.toLowerCase() === "true") return true;
  if (/^\d+$/.test(v)) throw new Error("TRUST_PROXY must be true, or the address of your proxy (for example 127.0.0.1 or 172.18.0.0/16), not a number");
  return v.split(",").map((p) => p.trim()).filter(Boolean);
}
