import { readFileSync } from "node:fs";
import { portKey, type PortKey, type Protocol } from "./allocator.js";

/**
 * Parse a /proc/net/{tcp,tcp6,udp,udp6} table into the set of locally bound ports.
 * TCP only counts LISTEN (0A); UDP counts any bound socket (07 = unconnected).
 */
export function parseProcNet(content: string, protocol: Protocol): Set<PortKey> {
  const out = new Set<PortKey>();
  for (const line of content.split("\n").slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 4) continue;
    const [, local, , state] = cols;
    if (protocol === "tcp" && state !== "0A") continue;
    if (protocol === "udp" && state !== "07") continue;
    const port = parseInt(local.split(":")[1], 16);
    if (Number.isFinite(port)) out.add(portKey(port, protocol));
  }
  return out;
}

/** Ports currently bound on the host. Needs host networking so /proc/net reflects the host, not the container. */
export function listHostPorts(procDir = "/proc/net"): Set<PortKey> {
  const out = new Set<PortKey>();
  for (const [file, proto] of [["tcp", "tcp"], ["tcp6", "tcp"], ["udp", "udp"], ["udp6", "udp"]] as const) {
    try {
      for (const k of parseProcNet(readFileSync(`${procDir}/${file}`, "utf8"), proto)) out.add(k);
    } catch {
      /* table unavailable (e.g. no IPv6) */
    }
  }
  return out;
}
