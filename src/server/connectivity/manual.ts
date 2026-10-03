import { and, eq } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { schema } from "../db/index.js";
import type { Protocol } from "../ports/allocator.js";
import { echoPublicIp, OWNER_PREFIX, type ConnectivityProvider, type Mapping, type OpenResult } from "./provider.js";

/**
 * No router automation. The panel records the forwarding rules the user must add and treats a rule as
 * open only after they confirm it.
 */
export class ManualProvider implements ConnectivityProvider {
  readonly kind = "manual" as const;

  constructor(
    private readonly db: Db,
    private readonly ipEchoUrl: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async ensureOpen(serverId: string, slug: string, port: number, protocol: Protocol, lanIp: string): Promise<OpenResult> {
    const { manualRules } = schema;
    const existing = this.db.select().from(manualRules).where(and(eq(manualRules.port, port), eq(manualRules.protocol, protocol))).get();
    if (!existing) this.db.insert(manualRules).values({ serverId, port, protocol, confirmed: false }).run();
    if (existing?.confirmed) return { state: "open" };
    return {
      state: "pending",
      instructions: `In your router's port forwarding settings, forward ${protocol.toUpperCase()} ${port} to ${lanIp}:${port}, then confirm it here.`,
    };
  }

  async ensureClosed(_serverId: string, _slug: string, port: number, protocol: Protocol): Promise<void> {
    const { manualRules } = schema;
    this.db.delete(manualRules).where(and(eq(manualRules.port, port), eq(manualRules.protocol, protocol))).run();
  }

  async list(): Promise<Mapping[]> {
    const rows = this.db
      .select({ port: schema.manualRules.port, protocol: schema.manualRules.protocol, slug: schema.servers.slug, confirmed: schema.manualRules.confirmed })
      .from(schema.manualRules)
      .innerJoin(schema.servers, eq(schema.servers.id, schema.manualRules.serverId))
      .all();
    return rows.filter((r) => r.confirmed).map((r) => ({ port: r.port, protocol: r.protocol, description: `${OWNER_PREFIX}${r.slug}` }));
  }

  externalIp(): Promise<string> {
    return echoPublicIp(this.ipEchoUrl, this.fetchFn);
  }
}
