import { describe, expect, it } from "vitest";
import { HostStats, parseCpu, parseMeminfo, parseNetDev, parseUptime } from "../src/server/host-stats.js";
import { usageFromStats } from "../src/server/docker/driver.js";

const stat = (busyish: number, idle: number) => `cpu  ${busyish} 0 0 ${idle} 0 0 0 0 0 0\ncpu0 1 2 3 4\n`;
const netdev = (rx: number, tx: number) =>
  `Inter-|   Receive                                                |  Transmit\n face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed\n` +
  `    lo: 999999 1 0 0 0 0 0 0 999999 1 0 0 0 0 0 0\n` +
  `  eno1: ${rx} 10 0 0 0 0 0 0 ${tx} 10 0 0 0 0 0 0\n` +
  `docker0: 5000 1 0 0 0 0 0 0 5000 1 0 0 0 0 0 0\n` +
  `veth12ab: 7000 1 0 0 0 0 0 0 7000 1 0 0 0 0 0 0\n`;

describe("proc parsing", () => {
  it("reads busy and total jiffies", () => {
    expect(parseCpu(stat(30, 70))).toEqual({ busy: 30, total: 100 });
    expect(parseCpu("nonsense")).toBeNull();
  });
  it("counts memory used as total minus available", () => {
    expect(parseMeminfo("MemTotal:       1000 kB\nMemFree: 10 kB\nMemAvailable:    250 kB\n")).toEqual({ totalBytes: 1024000, usedBytes: 768000 });
    expect(parseMeminfo("")).toBeNull();
  });
  it("reads uptime in seconds", () => {
    expect(parseUptime("2050000.51 15000000.00\n")).toBe(2050001);
    expect(parseUptime("")).toBeNull();
  });
  it("ignores loopback, Docker bridges and veth pairs", () => {
    expect(parseNetDev(netdev(1000, 2000))).toEqual({ rx: 1000, tx: 2000 });
  });
});

describe("HostStats", () => {
  function make() {
    const files: Record<string, string> = {
      "/proc/stat": stat(0, 100),
      "/proc/net/dev": netdev(0, 0),
      "/proc/meminfo": "MemTotal: 2000 kB\nMemAvailable: 500 kB\n",
    };
    let t = 1_000_000;
    const hs = new HostStats(["/missing", "/data"], (f) => files[f], () => t, (p) => {
      if (p === "/missing") throw new Error("ENOENT");
      return { bsize: 1024, blocks: 1000, bfree: 400 };
    }, 8);
    return { hs, set: (patch: Partial<typeof files>) => Object.assign(files, patch), tick: (ms: number) => (t += ms) };
  }

  it("has no rates until two samples exist, then averages between them", () => {
    const { hs, set, tick } = make();
    expect(hs.snapshot()).toMatchObject({ cpu: { percent: null, cores: 8 }, network: null });
    set({ "/proc/stat": stat(25, 175), "/proc/net/dev": netdev(10_000, 5_000) });
    tick(5000);
    const s = hs.snapshot();
    expect(s.cpu.percent).toBeCloseTo(25);
    expect(s.network).toEqual({ rxPerSec: 2000, txPerSec: 1000 });
  });

  it("reuses the last rates when polled again within 2 seconds", () => {
    const { hs, set, tick } = make();
    hs.snapshot();
    set({ "/proc/stat": stat(50, 150) });
    tick(5000);
    const first = hs.snapshot().cpu.percent;
    set({ "/proc/stat": stat(500, 150) });
    tick(500);
    expect(hs.snapshot().cpu.percent).toBe(first);
  });

  it("reports memory and falls through to the next storage path", () => {
    const s = make().hs.snapshot();
    expect(s.memory).toEqual({ totalBytes: 2000 * 1024, usedBytes: 1500 * 1024 });
    expect(s.storage).toEqual({ totalBytes: 1000 * 1024, usedBytes: 600 * 1024 });
  });

  it("returns nulls instead of throwing when /proc is unreadable", () => {
    const hs = new HostStats([], () => { throw new Error("no proc"); });
    expect(hs.snapshot()).toMatchObject({ cpu: { percent: null }, memory: null, storage: null, network: null });
  });
});

describe("usageFromStats", () => {
  it("computes share of host CPU and excludes page cache from memory", () => {
    const u = usageFromStats({
      cpu_stats: { cpu_usage: { total_usage: 600 }, system_cpu_usage: 10_000 },
      precpu_stats: { cpu_usage: { total_usage: 400 }, system_cpu_usage: 8_000 },
      memory_stats: { usage: 1000, stats: { inactive_file: 300 } },
    });
    expect(u).toEqual({ cpuPercent: 10, memBytes: 700 });
  });
  it("has no CPU figure without an earlier sample", () => {
    expect(usageFromStats({ cpu_stats: { cpu_usage: { total_usage: 5 }, system_cpu_usage: 100 }, precpu_stats: {}, memory_stats: { usage: 10 } }).cpuPercent).toBeNull();
  });
});
