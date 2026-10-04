/**
 * A small client for the playit.gg agent API (see docs/relay-playit.md). Everything read from the answers is parsed
 * defensively: playit.gg's replies were read from the agent's source and have not been run against every account, so a
 * field that is missing or renamed means "not known yet", never a crash. The secret key is only ever sent in the
 * Authorization header and never appears in an error message.
 */

const BASE = "https://api.playit.gg";

export type TunnelProto = "tcp" | "udp" | "both";

export interface PlayitTunnel {
  id: string;
  name: string | null;
  proto: TunnelProto | null;
  /** `host:port` players use, or null while playit.gg has not assigned one. */
  address: string | null;
  /** What the agent forwards to, when the answer says. */
  localPort: number | null;
  disabled: boolean;
}

export interface PlayitRundata {
  agentId: string | null;
  /** playit.gg's word for the account (for example `verified` or `guest`), when given. */
  accountStatus: string | null;
  tunnels: PlayitTunnel[];
}

export class PlayitError extends Error {
  constructor(
    message: string,
    /** `auth`: the key is wrong or not allowed to do this; `refused`: playit.gg said no (for example a plan limit); `network`: could not reach it. */
    public readonly kind: "auth" | "refused" | "network" | "unexpected",
  ) {
    super(message);
  }
}

export type FetchFn = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const proto = (v: unknown): TunnelProto | null => (v === "tcp" || v === "udp" || v === "both" ? v : null);

/** Turns either known `rundata` shape into one. Exported for tests. */
export function parseRundata(data: unknown): PlayitRundata {
  const d = isObj(data) ? data : {};
  const list = Array.isArray(d.tunnels) ? d.tunnels : [];
  const tunnels: PlayitTunnel[] = [];
  for (const raw of list) {
    if (!isObj(raw)) continue;
    const id = str(raw.id);
    if (!id) continue;
    // Newer shape: a ready-made `display_address`. Older shape: `assigned_domain` (or a custom domain) plus the first public port.
    let address = str(raw.display_address);
    if (!address) {
      const domain = str(raw.custom_domain) ?? str(raw.assigned_domain);
      const from = isObj(raw.port) ? num(raw.port.from) : null;
      if (domain && from !== null) address = `${domain}:${from}`;
    }
    tunnels.push({
      id,
      name: str(raw.name),
      proto: proto(raw.proto) ?? proto(raw.port_type),
      address,
      localPort: num(raw.local_port),
      disabled: (raw.disabled != null && raw.disabled !== false) || str(raw.disabled_reason) !== null,
    });
  }
  return { agentId: str(d.agent_id), accountStatus: str(d.account_status), tunnels };
}

export class PlayitClient {
  constructor(
    private readonly secret: string,
    private readonly fetchFn: FetchFn = (url, init) => fetch(url, init),
  ) {}

  private async call(path: string, body: unknown): Promise<unknown> {
    let res;
    try {
      res = await this.fetchFn(`${BASE}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Agent-Key ${this.secret}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new PlayitError("Could not reach playit.gg", "network");
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new PlayitError(`playit.gg answered with something unreadable (HTTP ${res.status})`, "unexpected");
    }
    const o = isObj(json) ? json : {};
    const data = isObj(o.data) ? o.data : {};
    if (o.status === "success") return o.data;
    if (o.status === "error" && data.type === "auth") {
      const why = str(data.message);
      throw new PlayitError(why === "InvalidAgentKey" ? "playit.gg does not accept that secret key" : `playit.gg refused the key${why ? ` (${why})` : ""}`, "auth");
    }
    if (o.status === "fail") throw new PlayitError(`playit.gg said no${typeof o.data === "string" ? ` (${o.data})` : str(data.type) ? ` (${str(data.type)})` : ""}`, "refused");
    throw new PlayitError(`playit.gg answered unexpectedly (HTTP ${res.status})`, "unexpected");
  }

  /** What the agent behind this key can see: its id and tunnels. Also the cheapest way to check that the key works. */
  async rundata(): Promise<PlayitRundata> {
    return parseRundata(await this.call("/agents/rundata", {}));
  }

  /**
   * Ask playit.gg to create a tunnel for this agent. This is **unverified** for agent keys: playit.gg may refuse (a read-only
   * key, a plan limit), which the caller treats as "do it by hand in the dashboard".
   */
  async createTunnel(t: { agentId: string; name: string; proto: TunnelProto; localIp: string; localPort: number }): Promise<string | null> {
    const out = await this.call("/tunnels/create", {
      name: t.name,
      tunnel_type: null,
      port_type: t.proto,
      port_count: 1,
      origin: { type: "agent", data: { agent_id: t.agentId, local_ip: t.localIp, local_port: t.localPort } },
      enabled: true,
      alloc: null,
      firewall_id: null,
      proxy_protocol: null,
    });
    return isObj(out) ? str(out.id) : null;
  }

  async deleteTunnel(tunnelId: string): Promise<void> {
    await this.call("/tunnels/delete", { tunnel_id: tunnelId });
  }
}
