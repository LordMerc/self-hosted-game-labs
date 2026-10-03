export const DNS_OWNER_PREFIX = "gamelabs:";
export const DDNS_COMMENT = `${DNS_OWNER_PREFIX}ddns`;
export const serverComment = (slug: string) => `${DNS_OWNER_PREFIX}${slug}`;

export class DnsError extends Error {}

export interface DnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied?: boolean;
  comment?: string | null;
}

export interface DnsClient {
  /** Create or update the A record for `name`. Never touches a record without our ddns tag. */
  upsertA(name: string, ip: string): Promise<"created" | "updated" | "unchanged">;
  /** Create or update `<slug>.<zone>` as a DNS-only CNAME to `target`. */
  upsertCname(slug: string, target: string): Promise<"created" | "updated" | "unchanged">;
  /** Delete `<slug>.<zone>` only if it carries the tag for that slug. */
  deleteCname(slug: string): Promise<boolean>;
  /** Slugs of every CNAME in the zone carrying a gamelabs tag (not the ddns A record). */
  listOwnedCnames(): Promise<string[]>;
  fqdn(slug: string): string;
}

interface CfEnvelope<T> {
  success: boolean;
  errors?: { code: number; message: string }[];
  result: T;
  result_info?: { total_pages: number };
}

export class CloudflareClient implements DnsClient {
  private zoneId?: string;

  constructor(
    private readonly token: string,
    private readonly zone: string,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly base = "https://api.cloudflare.com/client/v4",
  ) {}

  fqdn(slug: string): string {
    return `${slug}.${this.zone}`;
  }

  /** Throws a readable DnsError unless the token can see (and so edit) this zone. */
  async checkZone(): Promise<void> {
    await this.zoneIdOf();
  }

  /**
   * What a token can do, for the Settings page: is it active, and which zones can it see? A token without
   * Zone:Read can be valid yet unable to list zones; that is reported rather than thrown.
   */
  static async inspect(token: string, fetchFn: typeof fetch = fetch, base = "https://api.cloudflare.com/client/v4") {
    const call = async <T>(path: string) => {
      const res = await fetchFn(`${base}${path}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
      const data = (await res.json().catch(() => null)) as CfEnvelope<T> | null;
      if (!res.ok || !data?.success) throw new DnsError(data?.errors?.map((e) => e.message).join("; ") || res.statusText);
      return data.result;
    };
    try {
      const v = await call<{ status: string }>("/user/tokens/verify");
      if (v.status !== "active") return { valid: false as const, error: `Token is ${v.status}` };
    } catch (e) {
      return { valid: false as const, error: e instanceof Error ? e.message : String(e) };
    }
    try {
      const zones = await call<{ name: string }[]>("/zones?per_page=50&status=active");
      return { valid: true as const, zones: zones.map((z) => z.name).sort(), zonesError: null };
    } catch (e) {
      return { valid: true as const, zones: [] as string[], zonesError: e instanceof Error ? e.message : String(e) };
    }
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchFn(`${this.base}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    const data = (await res.json().catch(() => null)) as CfEnvelope<T> | null;
    if (!res.ok || !data?.success) {
      // Never include the token or request headers in the message.
      const detail = data?.errors?.map((e) => e.message).join("; ") || res.statusText;
      throw new DnsError(`Cloudflare ${method} ${path.split("?")[0].replace(/[0-9a-f]{32}/g, ":id")} failed (${res.status}): ${detail}`);
    }
    return data.result;
  }

  private async zoneIdOf(): Promise<string> {
    if (this.zoneId) return this.zoneId;
    const zones = await this.call<{ id: string }[]>("GET", `/zones?name=${encodeURIComponent(this.zone)}`);
    if (zones.length === 0) throw new DnsError(`Cloudflare zone "${this.zone}" not found for this token`);
    return (this.zoneId = zones[0].id);
  }

  private async find(type: string, name: string): Promise<DnsRecord | undefined> {
    const z = await this.zoneIdOf();
    const rows = await this.call<DnsRecord[]>("GET", `/zones/${z}/dns_records?type=${type}&name=${encodeURIComponent(name)}`);
    return rows[0];
  }

  private async upsert(type: "A" | "CNAME", name: string, content: string, comment: string) {
    const z = await this.zoneIdOf();
    const existing = await this.find(type, name);
    const desired = { type, name, content, proxied: false, ttl: 120, comment };
    if (!existing) {
      await this.call("POST", `/zones/${z}/dns_records`, desired);
      return "created" as const;
    }
    if (existing.comment !== comment) {
      throw new DnsError(`A ${type} record for ${name} already exists and was not created by Game Labs; refusing to modify it`);
    }
    if (existing.content === content && existing.proxied === false) return "unchanged" as const;
    await this.call("PUT", `/zones/${z}/dns_records/${existing.id}`, desired);
    return "updated" as const;
  }

  upsertA(name: string, ip: string) {
    return this.upsert("A", name, ip, DDNS_COMMENT);
  }

  upsertCname(slug: string, target: string) {
    return this.upsert("CNAME", this.fqdn(slug), target, serverComment(slug));
  }

  async listOwnedCnames(): Promise<string[]> {
    const z = await this.zoneIdOf();
    const slugs: string[] = [];
    for (let page = 1; ; page++) {
      const rows = await this.call<DnsRecord[]>("GET", `/zones/${z}/dns_records?type=CNAME&per_page=100&page=${page}`);
      for (const r of rows) {
        const c = r.comment ?? "";
        if (c.startsWith(DNS_OWNER_PREFIX) && r.name === this.fqdn(c.slice(DNS_OWNER_PREFIX.length))) slugs.push(c.slice(DNS_OWNER_PREFIX.length));
      }
      if (rows.length < 100) return slugs;
    }
  }

  async deleteCname(slug: string): Promise<boolean> {
    const existing = await this.find("CNAME", this.fqdn(slug));
    if (!existing || existing.comment !== serverComment(slug)) return false;
    await this.call("DELETE", `/zones/${await this.zoneIdOf()}/dns_records/${existing.id}`);
    return true;
  }
}
