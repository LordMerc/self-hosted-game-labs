import type { TemplatePort } from "../../shared/template.js";

export type Protocol = "tcp" | "udp";
export type PortKey = `${number}/${Protocol}`;
export const portKey = (port: number, protocol: Protocol): PortKey => `${port}/${protocol}`;

export interface Allocation {
  name: string;
  port: number;
  protocol: Protocol;
  env?: string;
}

export class PortConflictError extends Error {
  constructor(
    public readonly conflicts: PortKey[],
    public readonly suggestion: Allocation[] | null,
  ) {
    super(`Port conflict: ${conflicts.join(", ")} already in use`);
  }
}

const MAX_PORT = 65535;

/**
 * Pick host ports for a template. Host port == container port, and every port of a template is
 * shifted by the same offset so multi-port games (Valheim 2456-2457) stay a contiguous block.
 *
 * `taken` is every (port, protocol) the panel already owns; `busy` is every one the host is listening on.
 * Starts at the template defaults and increments until the whole set is free.
 */
export function allocatePorts(ports: TemplatePort[], taken: ReadonlySet<PortKey>, busy: ReadonlySet<PortKey>): Allocation[] {
  const free = (p: TemplatePort, shift: number) => {
    const key = portKey(p.default + shift, p.protocol);
    return !taken.has(key) && !busy.has(key);
  };
  const maxShift = MAX_PORT - Math.max(...ports.map((p) => p.default));
  for (let shift = 0; shift <= maxShift; shift++) {
    if (ports.every((p) => free(p, shift))) {
      return ports.map((p) => ({ name: p.name, port: p.default + shift, protocol: p.protocol, env: p.env }));
    }
  }
  throw new Error("No free port range available for this template");
}

/**
 * Validate a user-chosen set of ports (e.g. an edit in the deploy form). Duplicate (port, protocol)
 * pairs are hard-blocked, with a suggested free alternative attached to the error.
 */
export function checkPorts(
  chosen: Allocation[],
  template: TemplatePort[],
  taken: ReadonlySet<PortKey>,
  busy: ReadonlySet<PortKey>,
): void {
  const seen = new Set<PortKey>();
  const conflicts: PortKey[] = [];
  for (const a of chosen) {
    const key = portKey(a.port, a.protocol);
    if (seen.has(key) || taken.has(key) || busy.has(key)) conflicts.push(key);
    seen.add(key);
  }
  if (conflicts.length > 0) {
    let suggestion: Allocation[] | null = null;
    try {
      suggestion = allocatePorts(template, new Set([...taken, ...seen]), busy);
    } catch {
      /* no suggestion available */
    }
    throw new PortConflictError(conflicts, suggestion);
  }
}
