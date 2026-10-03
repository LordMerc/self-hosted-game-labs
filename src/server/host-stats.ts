import { readFileSync, statfsSync } from "node:fs";
import os from "node:os";

export interface HostSnapshot {
  /** Share of the whole machine in use, 0-100. Null until two samples exist. */
  cpu: { percent: number | null; cores: number };
  memory: { usedBytes: number; totalBytes: number } | null;
  storage: { usedBytes: number; totalBytes: number } | null;
  /** Bytes per second across physical interfaces. Null until two samples exist. */
  network: { rxPerSec: number; txPerSec: number } | null;
}

interface Sample {
  at: number;
  cpuBusy: number;
  cpuTotal: number;
  rx: number;
  tx: number;
}

/** First line of /proc/stat: busy and total jiffies (idle and iowait count as idle). */
export function parseCpu(stat: string): { busy: number; total: number } | null {
  const line = stat.split("\n").find((l) => l.startsWith("cpu "));
  if (!line) return null;
  const n = line.trim().split(/\s+/).slice(1).map(Number);
  if (n.length < 4 || n.some(Number.isNaN)) return null;
  const total = n.slice(0, 8).reduce((a, b) => a + b, 0); // user nice system idle iowait irq softirq steal
  const idle = n[3] + (n[4] ?? 0);
  return { busy: total - idle, total };
}

export function parseMeminfo(text: string): { usedBytes: number; totalBytes: number } | null {
  const kb = (key: string) => Number(new RegExp(`^${key}:\\s+(\\d+)`, "m").exec(text)?.[1]);
  const total = kb("MemTotal");
  const available = kb("MemAvailable");
  if (!total || Number.isNaN(available)) return null;
  return { totalBytes: total * 1024, usedBytes: (total - available) * 1024 };
}

/** Sum of /proc/net/dev counters over real interfaces (not loopback, Docker bridges or veth pairs). */
export function parseNetDev(text: string): { rx: number; tx: number } {
  let rx = 0;
  let tx = 0;
  for (const line of text.split("\n").slice(2)) {
    const [name, rest] = line.split(":");
    if (!rest) continue;
    const iface = name.trim();
    if (iface === "lo" || /^(docker|br-|veth|virbr|cni|flannel)/.test(iface)) continue;
    const f = rest.trim().split(/\s+/).map(Number);
    rx += f[0] || 0;
    tx += f[8] || 0;
  }
  return { rx, tx };
}

export class HostStats {
  private prev: Sample | null = null;
  private cpuPercent: number | null = null;
  private net: { rxPerSec: number; txPerSec: number } | null = null;

  constructor(
    private readonly storagePaths: string[],
    private readonly read: (file: string) => string = (f) => readFileSync(f, "utf8"),
    private readonly now: () => number = Date.now,
    private readonly statfs: (p: string) => { bsize: number; blocks: number; bfree: number } = (p) => statfsSync(p),
    private readonly cores: number = os.cpus().length,
  ) {}

  private sample(): Sample | null {
    try {
      const cpu = parseCpu(this.read("/proc/stat"));
      if (!cpu) return null;
      const net = parseNetDev(this.read("/proc/net/dev"));
      return { at: this.now(), cpuBusy: cpu.busy, cpuTotal: cpu.total, rx: net.rx, tx: net.tx };
    } catch {
      return null;
    }
  }

  /** Rates are averaged between calls, so poll at a steady pace. Calls closer than 2 s apart reuse the last rates. */
  snapshot(): HostSnapshot {
    const cur = this.sample();
    if (cur) {
      if (!this.prev) this.prev = cur;
      else if (cur.at - this.prev.at >= 2000) {
        const dt = (cur.at - this.prev.at) / 1000;
        const dTotal = cur.cpuTotal - this.prev.cpuTotal;
        this.cpuPercent = dTotal > 0 ? Math.min(100, Math.max(0, ((cur.cpuBusy - this.prev.cpuBusy) / dTotal) * 100)) : this.cpuPercent;
        // Counters can reset (interface removed); treat a drop as no data rather than a huge negative.
        this.net = {
          rxPerSec: Math.max(0, (cur.rx - this.prev.rx) / dt),
          txPerSec: Math.max(0, (cur.tx - this.prev.tx) / dt),
        };
        this.prev = cur;
      }
    }
    let memory: HostSnapshot["memory"] = null;
    try {
      memory = parseMeminfo(this.read("/proc/meminfo"));
    } catch {
      /* not Linux */
    }
    return { cpu: { percent: this.cpuPercent, cores: this.cores }, memory, storage: this.storage(), network: this.net };
  }

  private storage(): HostSnapshot["storage"] {
    for (const p of this.storagePaths) {
      try {
        const s = this.statfs(p);
        const total = s.blocks * s.bsize;
        if (total > 0) return { totalBytes: total, usedBytes: total - s.bfree * s.bsize };
      } catch {
        /* try the next path */
      }
    }
    return null;
  }
}
