import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Config } from "../config.js";
import type { Db } from "../db/index.js";
import { schema } from "../db/index.js";
import type { DnsContext } from "../servers/service.js";
import { CloudflareClient } from "./cloudflare.js";

const K_TOKEN = "dns_cf_token";
const K_ZONE = "dns_zone";
const K_HOST = "dns_host";

/** The token is encrypted at rest with a key derived from the session secret (which lives in the data volume). */
export function encrypt(plain: string, secret: string): string {
  const key = createHash("sha256").update(secret).digest();
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString("base64")).join(".");
}

export function decrypt(blob: string, secret: string): string | null {
  try {
    const [iv, tag, enc] = blob.split(".").map((p) => Buffer.from(p, "base64"));
    const d = createDecipheriv("aes-256-gcm", createHash("sha256").update(secret).digest(), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(enc), d.final()]).toString("utf8");
  } catch {
    return null; // wrong secret or corrupted: treat as not configured
  }
}

export interface DnsStatus {
  configured: boolean;
  /** `env` when CF_API_TOKEN / CF_ZONE / PUBLIC_HOST are set, which override anything saved in the app. */
  source: "env" | "app" | null;
  zone: string | null;
  host: string | null;
  tokenSet: boolean;
}

/** Cloudflare settings: environment variables win, otherwise whatever was saved on the Settings page. */
export class DnsSettings {
  constructor(
    private readonly db: Db,
    private readonly config: Config,
    private readonly makeClient: (token: string, zone: string) => CloudflareClient = (t, z) => new CloudflareClient(t, z),
  ) {}

  private get(key: string): string | null {
    return this.db.select().from(schema.settings).where(eq(schema.settings.key, key)).get()?.value ?? null;
  }

  private set(key: string, value: string) {
    this.db.insert(schema.settings).values({ key, value }).onConflictDoUpdate({ target: schema.settings.key, set: { value } }).run();
  }

  private resolve(): { token: string; zone: string; host: string; source: "env" | "app" } | null {
    const { CF_API_TOKEN, CF_ZONE, PUBLIC_HOST, SESSION_SECRET } = this.config;
    if (CF_API_TOKEN && CF_ZONE && PUBLIC_HOST) return { token: CF_API_TOKEN, zone: CF_ZONE, host: PUBLIC_HOST, source: "env" };
    const enc = this.get(K_TOKEN);
    const zone = this.get(K_ZONE);
    const host = this.get(K_HOST);
    const token = enc ? decrypt(enc, SESSION_SECRET) : null;
    return token && zone && host ? { token, zone, host, source: "app" } : null;
  }

  /** The DNS context the server service uses; undefined when nothing is configured. */
  current(): DnsContext | undefined {
    const r = this.resolve();
    return r ? { client: this.makeClient(r.token, r.zone), host: r.host, zone: r.zone } : undefined;
  }

  status(): DnsStatus {
    const r = this.resolve();
    return { configured: !!r, source: r?.source ?? null, zone: r?.zone ?? null, host: r?.host ?? null, tokenSet: !!r };
  }

  /** Save from the Settings page after confirming the token can reach the zone. A blank token keeps the saved one. */
  async save(input: { token?: string; zone: string; host: string }): Promise<void> {
    const zone = input.zone.trim().toLowerCase();
    const host = input.host.trim().toLowerCase();
    if (!zone) throw new Error("Choose a domain");
    if (host !== zone && !host.endsWith(`.${zone}`)) throw new Error(`The hostname must be inside ${zone}, for example play.${zone}`);
    const token = input.token?.trim() || (this.get(K_TOKEN) ? decrypt(this.get(K_TOKEN)!, this.config.SESSION_SECRET) : null);
    if (!token) throw new Error("Paste your Cloudflare API token");
    await this.makeClient(token, zone).checkZone();
    this.set(K_TOKEN, encrypt(token, this.config.SESSION_SECRET));
    this.set(K_ZONE, zone);
    this.set(K_HOST, host);
  }

  clear() {
    for (const k of [K_TOKEN, K_ZONE, K_HOST]) this.db.delete(schema.settings).where(eq(schema.settings.key, k)).run();
  }
}
