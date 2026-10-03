import Docker from "dockerode";
import type { Protocol } from "../ports/allocator.js";

export const LABEL_MANAGED = "gamelabs.managed";
export const LABEL_ID = "gamelabs.id";
export const LABEL_SLUG = "gamelabs.slug";

export interface ContainerSpec {
  name: string;
  image: string;
  env: Record<string, string>;
  /** Host port == container port. */
  ports: { port: number; protocol: Protocol }[];
  binds: { host: string; container: string }[];
  labels: Record<string, string>;
}

export type ContainerState = "running" | "paused" | "exited" | "missing";

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
