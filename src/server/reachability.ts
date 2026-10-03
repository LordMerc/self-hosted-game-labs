/**
 * Asking an outside machine whether a TCP port on our public IP accepts connections.
 *
 * This is the one place the panel sends your public IP and a port number to a third party, and only when someone
 * presses "Run" on the Network panel. It never claims more than the answer shows: when the service cannot be
 * reached or answers with something unexpected, the result is "unknown", not "open" or "closed".
 */

export interface TcpProbeResult {
  state: "open" | "closed" | "unknown";
  /** One short line for the person looking at the result. */
  detail: string;
}

export interface TcpProbe {
  /** Shown to the user, so they know who was asked. */
  readonly name: string;
  check(ip: string, port: number): Promise<TcpProbeResult>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type NodeReply = { time?: unknown; address?: unknown; error?: unknown };

/** check-host.net: connects to the port from a few places around the world. Free, no account. https://check-host.net/about/api */
export class CheckHostProbe implements TcpProbe {
  readonly name = "check-host.net";

  constructor(
    private readonly fetchFn: typeof fetch = fetch,
    private readonly base = "https://check-host.net",
    private readonly opts: { nodes?: number; pollMs?: number; timeoutMs?: number } = {},
  ) {}

  private async getJson(path: string): Promise<unknown> {
    const res = await this.fetchFn(`${this.base}${path}`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`${this.name} answered HTTP ${res.status}`);
    return res.json();
  }

  async check(ip: string, port: number): Promise<TcpProbeResult> {
    const nodes = this.opts.nodes ?? 3;
    const deadline = Date.now() + (this.opts.timeoutMs ?? 20_000);
    let start: { ok?: unknown; request_id?: unknown; error?: unknown };
    try {
      start = (await this.getJson(`/check-tcp?host=${encodeURIComponent(`${ip}:${port}`)}&max_nodes=${nodes}`)) as typeof start;
    } catch (e) {
      return { state: "unknown", detail: `Could not reach ${this.name}: ${e instanceof Error ? e.message : String(e)}` };
    }
    if (typeof start.request_id !== "string") {
      const why = typeof start.error === "string" ? start.error : JSON.stringify(start).slice(0, 120);
      return { state: "unknown", detail: `${this.name} did not start the check (${why}). If it says limit, try again in a minute.` };
    }

    let replies: Record<string, unknown> = {};
    while (Date.now() < deadline) {
      await sleep(this.opts.pollMs ?? 1500);
      try {
        replies = (await this.getJson(`/check-result/${start.request_id}`)) as Record<string, unknown>;
      } catch (e) {
        return { state: "unknown", detail: `Could not read the result from ${this.name}: ${e instanceof Error ? e.message : String(e)}` };
      }
      const values = Object.values(replies);
      if (values.length > 0 && values.every((v) => v !== null)) break;
    }
    return interpret(replies, this.name);
  }
}

/** Turn check-host's per-location replies into one answer. Exported for tests. */
export function interpret(replies: Record<string, unknown>, who: string): TcpProbeResult {
  let reached = 0;
  let failed = 0;
  const errors = new Set<string>();
  for (const v of Object.values(replies)) {
    if (!Array.isArray(v)) continue; // null: that location never answered
    const first = (v.flat() as NodeReply[]).find((x) => x && typeof x === "object");
    if (!first) continue;
    if (typeof first.time === "number") reached++;
    else if (typeof first.error === "string") {
      failed++;
      errors.add(first.error);
    }
  }
  const total = reached + failed;
  if (total === 0) return { state: "unknown", detail: `${who} gave no answer in time` };
  if (reached > 0) return { state: "open", detail: `Connected from ${reached} of ${total} locations` };
  const why = [...errors].join(", ");
  return { state: "closed", detail: `Could not connect from any of ${total} locations${why ? ` (${why})` : ""}` };
}
