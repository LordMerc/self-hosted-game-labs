import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Protocol } from "../ports/allocator.js";
import {
  ConnectivityError,
  describeMapping,
  OWNER_PREFIX,
  type ConnectivityProvider,
  type Mapping,
  type OpenResult,
} from "./provider.js";

const execFileAsync = promisify(execFile);

/** Runs `upnpc` with args; resolves stdout. Injected so tests never touch a router. */
export type UpnpcRunner = (args: string[]) => Promise<string>;

export const runUpnpc: UpnpcRunner = async (args) => {
  try {
    const { stdout, stderr } = await execFileAsync("upnpc", args, { timeout: 15_000 });
    return stderr ? `${stdout}\n${stderr}` : stdout;
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stdout?: string };
    if (err.code === "ENOENT") throw new ConnectivityError("`upnpc` (miniupnpc) is not installed");
    // upnpc exits non-zero on some failures but still prints useful output.
    if (typeof err.stdout === "string" && err.stdout.length > 0) return `${err.stdout}\n${(err as { stderr?: string }).stderr ?? ""}`;
    throw new ConnectivityError(`upnpc failed: ${err.message}`);
  }
};

const NO_IGD = /No IGD UPnP Device found|No valid UPNP Internet Gateway Device/i;
const UPNP_OFF =
  "No UPnP router found. Turn UPnP on in your router (it is off by default on some), or switch CONNECTIVITY to manual.";

export interface UpnpEntry extends Mapping {
  internalIp: string;
  internalPort: number;
}

/** Parse `upnpc -l` output. Lines look like: ` 0 UDP  8211->192.168.1.50:8211 'gamelabs:palworld' '' 0` */
export function parseUpnpList(out: string): { entries: UpnpEntry[]; externalIp?: string } {
  const entries: UpnpEntry[] = [];
  for (const line of out.split("\n")) {
    const m = line.match(/^\s*\d+\s+(TCP|UDP)\s+(\d+)->([\d.]+):(\d+)\s+'([^']*)'/i);
    if (m) {
      entries.push({
        protocol: m[1].toLowerCase() as Protocol,
        port: Number(m[2]),
        internalIp: m[3],
        internalPort: Number(m[4]),
        description: m[5],
      });
    }
  }
  return { entries, externalIp: out.match(/ExternalIPAddress\s*=\s*(\d{1,3}(?:\.\d{1,3}){3})/)?.[1] };
}

export class UpnpProvider implements ConnectivityProvider {
  readonly kind = "upnp" as const;

  /**
   * `fallbackIp` is asked when the router answers but does not report its external IP (some do not), so the
   * panel can still show and publish the address. It is not used when no router is found at all.
   */
  constructor(
    private readonly run: UpnpcRunner = runUpnpc,
    private readonly fallbackIp?: () => Promise<string>,
    /** LAN address of this machine. Makes `upnpc` search for the router on that network interface only. */
    private readonly bindIp?: string,
  ) {}

  /** Control URL of the router, learned when discovery says "not connected" (see `upnpc`). */
  private rootUrl?: string;

  /**
   * Every upnpc call goes through here so discovery is pinned to the right interface. Some routers (TP-Link Deco)
   * are found but flagged "(not connected?)", and then upnpc stops without querying them. In that case we take the
   * router's description URL from the discovery output and talk to it directly with `-u`.
   */
  private async upnpc(args: string[]): Promise<string> {
    const base = this.bindIp ? ["-m", this.bindIp] : [];
    const out = await this.run([...base, ...(this.rootUrl ? ["-u", this.rootUrl] : []), ...args]);
    if (!this.rootUrl && /not connected/i.test(out) && !/ExternalIPAddress|redirected to|Local LAN ip/i.test(out)) {
      const url = out.match(/desc:\s*(http\S+)/)?.[1];
      if (url) {
        this.rootUrl = url;
        return this.run([...base, "-u", url, ...args]);
      }
    }
    return out;
  }

  private async listAll() {
    const out = await this.upnpc(["-l"]);
    if (NO_IGD.test(out)) throw new ConnectivityError(UPNP_OFF);
    return parseUpnpList(out);
  }

  async ensureOpen(_serverId: string, slug: string, port: number, protocol: Protocol, lanIp: string): Promise<OpenResult> {
    const { entries } = await this.listAll();
    const current = entries.find((e) => e.port === port && e.protocol === protocol);
    if (current && !current.description.startsWith(OWNER_PREFIX)) {
      throw new ConnectivityError(`${protocol.toUpperCase()} ${port} is already forwarded on the router by something else ("${current.description}")`);
    }
    if (current && current.internalIp === lanIp && current.description === describeMapping(slug)) return { state: "open" };
    const out = await this.upnpc(["-e", describeMapping(slug), "-a", lanIp, String(port), String(port), protocol.toUpperCase()]);
    if (NO_IGD.test(out)) throw new ConnectivityError(UPNP_OFF);
    if (/failed|error/i.test(out) && !/is redirected to/i.test(out)) {
      throw new ConnectivityError(`The router refused the port mapping for ${protocol.toUpperCase()} ${port}: ${out.trim().split("\n").slice(-2).join(" ").slice(0, 200)}`);
    }
    return { state: "open" };
  }

  async ensureClosed(_serverId: string, slug: string, port: number, protocol: Protocol): Promise<void> {
    const { entries } = await this.listAll();
    const current = entries.find((e) => e.port === port && e.protocol === protocol);
    if (!current || current.description !== describeMapping(slug)) return; // absent, or not ours: leave it alone
    await this.upnpc(["-d", String(port), protocol.toUpperCase()]);
  }

  async list(): Promise<Mapping[]> {
    const { entries } = await this.listAll();
    return entries.filter((e) => e.description.startsWith(OWNER_PREFIX)).map(({ port, protocol, description }) => ({ port, protocol, description }));
  }

  async diagnose(): Promise<string> {
    return (await this.upnpc(["-l"])).trim().slice(0, 4000);
  }

  async externalIp(): Promise<string> {
    const { externalIp } = await this.listAll();
    if (externalIp && externalIp !== "0.0.0.0") return externalIp;
    if (this.fallbackIp) return this.fallbackIp();
    throw new ConnectivityError("The router did not report an external IP");
  }
}
