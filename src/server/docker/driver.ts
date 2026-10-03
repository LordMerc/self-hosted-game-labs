import Docker from "dockerode";
import type { Protocol } from "../ports/allocator.js";

export const LABEL_MANAGED = "gamelabs.managed";
export const LABEL_ID = "gamelabs.id";
export const LABEL_SLUG = "gamelabs.slug";

export interface ContainerSpec {
  name: string;
  image: string;
  env: Record<string, string>;
  /** Arguments for the image's own start-up command. */
  command?: string[];
  tty?: boolean;
  /** Host port == container port. */
  ports: { port: number; protocol: Protocol }[];
  binds: { host: string; container: string }[];
  labels: Record<string, string>;
}

export type ContainerState = "running" | "paused" | "exited" | "missing";

export interface ContainerUsage {
  /** Share of the whole host's CPU, 0-100. Null when Docker has no earlier sample yet. */
  cpuPercent: number | null;
  memBytes: number;
}

interface RawStats {
  cpu_stats?: { cpu_usage?: { total_usage?: number }; system_cpu_usage?: number };
  precpu_stats?: { cpu_usage?: { total_usage?: number }; system_cpu_usage?: number };
  memory_stats?: { usage?: number; stats?: Record<string, number> };
}

/** Turn one Docker stats reply into the figures the panel shows (page cache is not counted as memory use). */
export function usageFromStats(s: RawStats): ContainerUsage {
  const cur = s.cpu_stats;
  const pre = s.precpu_stats;
  const dCpu = (cur?.cpu_usage?.total_usage ?? 0) - (pre?.cpu_usage?.total_usage ?? 0);
  const dSys = (cur?.system_cpu_usage ?? 0) - (pre?.system_cpu_usage ?? 0);
  const havePrev = pre?.system_cpu_usage !== undefined && dSys > 0;
  const m = s.memory_stats;
  const cache = m?.stats?.inactive_file ?? m?.stats?.total_inactive_file ?? m?.stats?.cache ?? 0;
  return {
    cpuPercent: havePrev ? Math.min(100, Math.max(0, (dCpu / dSys) * 100)) : null,
    memBytes: Math.max(0, (m?.usage ?? 0) - cache),
  };
}

/** The small slice of Docker the panel needs. Swapped for a fake in tests. */
export interface ContainerDriver {
  pullImage(image: string, onProgress?: (line: string) => void): Promise<void>;
  /** Returns the container id. Idempotent by name: an existing managed container with that name is reused. */
  create(spec: ContainerSpec): Promise<string>;
  start(id: string): Promise<void>;
  stop(id: string): Promise<void>;
  restart(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  state(id: string): Promise<ContainerState>;
  /** When the container's current run began (changes on every restart), or null if unknown. */
  startedAt(id: string): Promise<string | null>;
  /** Run a command inside the running container and collect what it prints. Never goes through a shell. */
  exec(id: string, cmd: string[], opts?: { timeoutMs?: number }): Promise<{ exitCode: number | null; output: string }>;
  /** Current CPU and memory of a running container. */
  usage(id: string): Promise<ContainerUsage>;
  /** Follow logs until the signal aborts. */
  streamLogs(id: string, onLine: (line: string) => void, signal: AbortSignal, tail?: number): Promise<void>;
}

export class DockerodeDriver implements ContainerDriver {
  constructor(private readonly docker = new Docker({ socketPath: "/var/run/docker.sock" })) {}

  async pullImage(image: string, onProgress?: (line: string) => void): Promise<void> {
    try {
      await this.pull(image, onProgress);
    } catch (e) {
      // Registry unreachable or a locally built image: carry on if we already have it.
      const have = await this.docker.getImage(image).inspect().then(() => true, () => false);
      if (!have) throw e;
    }
  }

  private pull(image: string, onProgress?: (line: string) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      this.docker.pull(image, (err: Error | null, stream: NodeJS.ReadableStream) => {
        if (err) return reject(err);
        this.docker.modem.followProgress(
          stream,
          (e: Error | null) => (e ? reject(e) : resolve()),
          (ev: { status?: string; id?: string; progress?: string }) =>
            onProgress?.([ev.id, ev.status, ev.progress].filter(Boolean).join(" ")),
        );
      });
    });
  }

  async create(spec: ContainerSpec): Promise<string> {
    const existing = await this.docker.listContainers({ all: true, filters: { name: [`^/${spec.name}$`] } });
    const match = existing.find((c) => c.Labels?.[LABEL_MANAGED] === "true");
    if (match) return match.Id;
    if (existing.length > 0) throw new Error(`A container named "${spec.name}" already exists and is not managed by Game Labs`);

    const exposed: Record<string, object> = {};
    const bindings: Record<string, { HostPort: string }[]> = {};
    for (const p of spec.ports) {
      const key = `${p.port}/${p.protocol}`;
      exposed[key] = {};
      bindings[key] = [{ HostPort: String(p.port) }];
    }
    const container = await this.docker.createContainer({
      name: spec.name,
      Image: spec.image,
      Env: Object.entries(spec.env).map(([k, v]) => `${k}=${v}`),
      ...(spec.command ? { Cmd: spec.command } : {}),
      ...(spec.tty ? { Tty: true, OpenStdin: true } : {}),
      Labels: spec.labels,
      ExposedPorts: exposed,
      HostConfig: {
        PortBindings: bindings,
        Binds: spec.binds.map((b) => `${b.host}:${b.container}`),
        RestartPolicy: { Name: "unless-stopped" },
      },
    });
    return container.id;
  }

  async start(id: string) {
    try {
      await this.docker.getContainer(id).start();
    } catch (e) {
      if ((e as { statusCode?: number }).statusCode !== 304) throw e; // already started
    }
  }

  async stop(id: string) {
    try {
      await this.docker.getContainer(id).stop({ t: 30 });
    } catch (e) {
      if ((e as { statusCode?: number }).statusCode !== 304) throw e; // already stopped
    }
  }

  async restart(id: string) {
    await this.docker.getContainer(id).restart({ t: 30 });
  }

  async remove(id: string) {
    try {
      await this.docker.getContainer(id).remove({ force: true });
    } catch (e) {
      if ((e as { statusCode?: number }).statusCode !== 404) throw e;
    }
  }

  async state(id: string): Promise<ContainerState> {
    try {
      const info = await this.docker.getContainer(id).inspect();
      if (info.State.Paused) return "paused";
      return info.State.Running ? "running" : "exited";
    } catch (e) {
      if ((e as { statusCode?: number }).statusCode === 404) return "missing";
      throw e;
    }
  }

  async startedAt(id: string): Promise<string | null> {
    try {
      return (await this.docker.getContainer(id).inspect()).State.StartedAt ?? null;
    } catch {
      return null;
    }
  }

  async exec(id: string, cmd: string[], opts: { timeoutMs?: number } = {}): Promise<{ exitCode: number | null; output: string }> {
    const exec = await this.docker.getContainer(id).exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true, Tty: false });
    const stream = (await exec.start({ hijack: true, stdin: false })) as unknown as NodeJS.ReadableStream & { destroy(): void };
    let output = "";
    const { Writable } = await import("node:stream");
    const sink = new Writable({
      write(chunk: Buffer, _enc, cb) {
        if (output.length < 200_000) output += chunk.toString("utf8");
        cb();
      },
    });
    this.docker.modem.demuxStream(stream, sink, sink);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => (stream.destroy(), reject(new Error("The command took too long and was stopped"))), opts.timeoutMs ?? 10_000);
      stream.on("end", () => (clearTimeout(timer), resolve()));
      stream.on("error", (e) => (clearTimeout(timer), reject(e)));
    });
    const info = await exec.inspect();
    return { exitCode: info.ExitCode ?? null, output };
  }

  async usage(id: string): Promise<ContainerUsage> {
    return usageFromStats((await this.docker.getContainer(id).stats({ stream: false })) as unknown as RawStats);
  }

  async streamLogs(id: string, onLine: (line: string) => void, signal: AbortSignal, tail = 200): Promise<void> {
    const stream = (await this.docker.getContainer(id).logs({ follow: true, stdout: true, stderr: true, tail })) as unknown as NodeJS.ReadableStream & {
      destroy(): void;
    };
    let buf = "";
    const sink = new (await import("node:stream")).Writable({
      write(chunk: Buffer, _enc, cb) {
        buf += chunk.toString("utf8");
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        lines.forEach(onLine);
        cb();
      },
    });
    this.docker.modem.demuxStream(stream, sink, sink);
    await new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => (stream.destroy(), resolve()), { once: true });
      stream.on("end", resolve);
      stream.on("error", resolve);
    });
  }
}
