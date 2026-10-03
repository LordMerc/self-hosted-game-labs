import type { Protocol } from "../ports/allocator.js";

export type OpenResult =
  | { state: "open" }
  /** Manual mode: the user still has to add this rule in their router. */
  | { state: "pending"; instructions: string };

export interface Mapping {
  port: number;
  protocol: Protocol;
  description: string;
}

/**
 * How game ports get from the internet to this machine. Every mapping the panel creates is described as
 * `gamelabs:<slug>`; providers must never modify or remove anything that does not carry that prefix.
 */
export interface ConnectivityProvider {
  readonly kind: "manual" | "upnp";
  ensureOpen(serverId: string, slug: string, port: number, protocol: Protocol, lanIp: string): Promise<OpenResult>;
  ensureClosed(serverId: string, slug: string, port: number, protocol: Protocol): Promise<void>;
  /** Mappings owned by Game Labs. */
  list(): Promise<Mapping[]>;
  externalIp(): Promise<string>;
}

export const OWNER_PREFIX = "gamelabs:";
export const describeMapping = (slug: string) => `${OWNER_PREFIX}${slug}`;

export class ConnectivityError extends Error {}

export async function echoPublicIp(url: string, fetchFn: typeof fetch = fetch): Promise<string> {
  const res = await fetchFn(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new ConnectivityError(`IP lookup failed (${res.status})`);
  const ip = (await res.text()).trim();
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) throw new ConnectivityError(`IP lookup returned something unexpected: ${ip.slice(0, 40)}`);
  return ip;
}
