import type { ContainerDriver, ContainerSpec, ContainerState } from "../../src/server/docker/driver.js";
import type { ConnectivityProvider, Mapping, OpenResult } from "../../src/server/connectivity/provider.js";
import type { DnsClient } from "../../src/server/dns/cloudflare.js";
import type { Protocol } from "../../src/server/ports/allocator.js";

export class FakeDocker implements ContainerDriver {
  containers = new Map<string, { spec: ContainerSpec; state: ContainerState }>();
  pulled: string[] = [];
  failPull = false;
  /** Make containers exit right after start (simulates a crashing game). */
  crashOnStart = false;

  async pullImage(image: string) {
    if (this.failPull) throw new Error("pull access denied");
    this.pulled.push(image);
  }
  async create(spec: ContainerSpec) {
    const existing = [...this.containers.entries()].find(([, c]) => c.spec.name === spec.name);
    if (existing) return existing[0];
    const id = `c${this.containers.size + 1}`;
    this.containers.set(id, { spec, state: "exited" });
    return id;
  }
  async start(id: string) {
    this.containers.get(id)!.state = this.crashOnStart ? "exited" : "running";
  }
  async stop(id: string) {
    this.containers.get(id)!.state = "exited";
  }
  async restart(id: string) {
    this.containers.get(id)!.state = "running";
  }
  async remove(id: string) {
    this.containers.delete(id);
  }
  async state(id: string): Promise<ContainerState> {
    return this.containers.get(id)?.state ?? "missing";
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
  ip = "203.0.113.7";
  async ensureOpen(_id: string, slug: string, port: number, protocol: Protocol): Promise<OpenResult> {
    if (this.fail) throw new Error(this.fail);
    this.open.set(`${port}/${protocol}`, slug);
    return { state: "open" };
  }
  async ensureClosed(_id: string, slug: string, port: number, protocol: Protocol) {
    if (this.open.get(`${port}/${protocol}`) === slug) this.open.delete(`${port}/${protocol}`);
  }
  async list(): Promise<Mapping[]> {
    return [...this.open].map(([k, slug]) => {
      const [port, protocol] = k.split("/");
      return { port: Number(port), protocol: protocol as Protocol, description: `gamelabs:${slug}` };
    });
  }
  async externalIp() {
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
