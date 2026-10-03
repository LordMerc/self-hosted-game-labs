import type { ContainerDriver, ContainerSpec, ContainerState, OtherPanelContainer } from "../../src/server/docker/driver.js";
import { RouterNotFoundError, type ConnectivityProvider, type Mapping, type OpenResult } from "../../src/server/connectivity/provider.js";
import type { DnsClient } from "../../src/server/dns/cloudflare.js";
import type { Protocol } from "../../src/server/ports/allocator.js";

export class FakeDocker implements ContainerDriver {
  containers = new Map<string, { spec: ContainerSpec; state: ContainerState; imageId?: string }>();
  /** Image ids on this host, by tag. */
  images = new Map<string, string>();
  /** What the registry serves for a tag right now (default `sha256:a1`). */
  remote = new Map<string, string>();
  registryDown = false;
  pulled: string[] = [];
  failPull = false;
  /** Make containers exit right after start (simulates a crashing game). */
  crashOnStart = false;

  async pullImage(image: string) {
    if (this.failPull) throw new Error("pull access denied");
    this.pulled.push(image);
    if (this.registryDown) {
      if (!this.images.has(image)) throw new Error("registry unreachable");
      return false;
    }
    this.images.set(image, this.remote.get(image) ?? "sha256:a1");
    return true;
  }
  async imageId(image: string) {
    return this.images.get(image) ?? null;
  }
  async containerImageId(id: string) {
    return this.containers.get(id)?.imageId ?? null;
  }
  async create(spec: ContainerSpec) {
    const existing = [...this.containers.entries()].find(([, c]) => c.spec.name === spec.name);
    if (existing) return existing[0];
    const id = `c${this.containers.size + 1}`;
    this.containers.set(id, { spec, state: "exited", imageId: this.images.get(spec.image) ?? "sha256:a1" });
    return id;
  }
  async start(id: string) {
    this.containers.get(id)!.state = this.crashOnStart ? "exited" : "running";
    this.starts.set(id, (this.starts.get(id) ?? 0) + 1);
  }
  async stop(id: string) {
    this.containers.get(id)!.state = "exited";
  }
  async restart(id: string) {
    this.containers.get(id)!.state = "running";
    this.starts.set(id, (this.starts.get(id) ?? 0) + 1);
  }
  async remove(id: string) {
    this.containers.delete(id);
  }
  async state(id: string): Promise<ContainerState> {
    return this.containers.get(id)?.state ?? "missing";
  }
  /** Whether the game inside has opened its UDP sockets yet (what the "Starting" check looks at). */
  gameListening = true;
  /** Set to make exec fail like an image without `cat`. */
  execFails = false;
  execLog: string[][] = [];
  execReply = (cmd: string[]) => `ran ${cmd.join(" ")}`;
  async startedAt(id: string) {
    return this.containers.has(id) ? `t${this.starts.get(id) ?? 0}` : null;
  }
  starts = new Map<string, number>();
  async exec(id: string, cmd: string[]) {
    this.execLog.push(cmd);
    if (this.execFails) throw new Error("exec failed");
    const c = this.containers.get(id);
    if (cmd[0] === "cat" && cmd[1] === "/proc/net/udp") {
      const rows = this.gameListening && c ? c.spec.ports.filter((p) => p.protocol === "udp").map((p, i) => `  ${i}: 00000000:${p.port.toString(16).toUpperCase().padStart(4, "0")} 00000000:0000 07 00000000:00000000 00:00000000 00000000     0        0 1 1 0000000000000000 0`) : [];
      return { exitCode: 0, output: ["  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode ref pointer drops", ...rows].join("\n") };
    }
    if (cmd[0] === "cat") return { exitCode: 0, output: "  sl  local_address\n" };
    return { exitCode: 0, output: this.execReply(cmd) };
  }
  others: OtherPanelContainer[] = [];
  async listOtherPanels() {
    return this.others;
  }
  usageById = new Map<string, { cpuPercent: number | null; memBytes: number }>();
  async usage(id: string) {
    return this.usageById.get(id) ?? { cpuPercent: 1.5, memBytes: 512 * 1024 * 1024 };
  }
  async streamLogs(_id: string, onLine: (l: string) => void, signal: AbortSignal) {
    onLine("hello from the game");
    await new Promise<void>((r) => signal.addEventListener("abort", () => r(), { once: true }));
  }
}

export class FakeConnectivity implements ConnectivityProvider {
  kind = "upnp" as const;
  open = new Map<string, string>(); // "8211/udp" -> slug
  fail: string | null = null;
  /** Simulates discovery finding no router at all. */
  missing = false;
  ip = "203.0.113.7";
  async ensureOpen(_id: string, slug: string, port: number, protocol: Protocol): Promise<OpenResult> {
    if (this.missing) throw new RouterNotFoundError("No UPnP router found.");
    if (this.fail) throw new Error(this.fail);
    this.open.set(`${port}/${protocol}`, slug);
    return { state: "open" };
  }
  async ensureClosed(_id: string, slug: string, port: number, protocol: Protocol) {
    if (this.open.get(`${port}/${protocol}`) === slug) this.open.delete(`${port}/${protocol}`);
  }
  async list(): Promise<Mapping[]> {
    if (this.missing) throw new RouterNotFoundError("No UPnP router found.");
    return [...this.open].map(([k, slug]) => {
      const [port, protocol] = k.split("/");
      return { port: Number(port), protocol: protocol as Protocol, description: `gamelabs:${slug}` };
    });
  }
  async externalIp() {
    if (this.missing) throw new RouterNotFoundError("No UPnP router found.");
    return this.ip;
  }
}

export class FakeDns implements DnsClient {
  a = new Map<string, string>();
  cnames = new Map<string, string>();
  fqdn(slug: string) {
    return `${slug}.example.com`;
  }
  async upsertA(name: string, ip: string) {
    const prev = this.a.get(name);
    this.a.set(name, ip);
    return prev === undefined ? ("created" as const) : prev === ip ? ("unchanged" as const) : ("updated" as const);
  }
  async upsertCname(slug: string, target: string) {
    this.cnames.set(slug, target);
    return "created" as const;
  }
  async listOwnedCnames() {
    return [...this.cnames.keys()];
  }
  async deleteCname(slug: string) {
    return this.cnames.delete(slug);
  }
}
