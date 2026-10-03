import { describe, expect, it } from "vitest";
import { StatsHistory, type PeakStore } from "../src/server/history.js";
import type { HostSnapshot } from "../src/server/host-stats.js";

const host = (cpu: number | null, rx = 0): HostSnapshot => ({ cpu: { percent: cpu, cores: 8 }, memory: null, storage: null, network: { rxPerSec: rx, txPerSec: 0 }, uptimeSec: 100 });
const memoryStore = (): PeakStore & { value: string | null } => {
  const s = { value: null as string | null, load: () => s.value, save: (v: string) => void (s.value = v) };
  return s;
};

describe("StatsHistory", () => {
  it("keeps only the newest points and reports the highest CPU in the window", () => {
    const h = new StatsHistory({ max: 3, intervalSec: 20 });
    for (const c of [90, 10, 20, 30]) h.record(host(c), {});
    const v = h.view();
    expect(v.host.cpu).toEqual([10, 20, 30]); // the 90 has aged out
    expect(v.peaks.cpuPercent).toBe(30);
  });

  it("keeps the host's memory and storage in use, with a gap when the host could not report them", () => {
    const h = new StatsHistory();
    h.record({ ...host(1), memory: { usedBytes: 7, totalBytes: 16 }, storage: { usedBytes: 27, totalBytes: 983 } }, {});
    h.record(host(1), {});
    const v = h.view();
    expect(v.host.mem).toEqual([7, null]);
    expect(v.host.storage).toEqual([27, null]);
  });

  it("sums the players that servers report, and leaves a gap when none report", () => {
    const h = new StatsHistory();
    h.record(host(1), { a: { cpuPercent: 1, memBytes: 5, players: { online: 3, max: 32 } }, b: { cpuPercent: null, memBytes: 6, players: { online: 2, max: 10 } }, c: { cpuPercent: 1, memBytes: 1, players: null } });
    h.record(host(1), { c: { cpuPercent: 1, memBytes: 1, players: null } });
    expect(h.view().host.players).toEqual([5, null]);
  });

  it("lines a server's series up with the host's and forgets servers that stopped", () => {
    const h = new StatsHistory();
    h.record(host(1), {});
    h.record(host(1), { a: { cpuPercent: 4, memBytes: 9, players: null } });
    expect(h.view().servers.a.cpu).toEqual([null, 4]);
    h.record(host(1), {});
    expect(h.view().servers).toEqual({});
  });

  it("remembers today's highest player count, and starts again on a new day", () => {
    const store = memoryStore();
    let day = "2026-10-03";
    const h = new StatsHistory({ store, today: () => day });
    const at = (n: number) => ({ a: { cpuPercent: null, memBytes: 0, players: { online: n, max: 10 } } });
    h.record(host(1), at(4));
    h.record(host(1), at(7));
    h.record(host(1), at(2));
    expect(h.view().peaks.playersToday).toBe(7);
    // A restarted panel reads the same figure back from the store.
    expect(new StatsHistory({ store, today: () => day }).view().peaks.playersToday).toBe(7);
    day = "2026-10-04";
    expect(h.view().peaks.playersToday).toBeNull();
    h.record(host(1), at(1));
    expect(h.view().peaks.playersToday).toBe(1);
  });

  it("reports no player peak when nothing is stored or the stored value is garbage", () => {
    const store = memoryStore();
    store.value = "not json";
    const h = new StatsHistory({ store });
    expect(h.view().peaks.playersToday).toBeNull();
    h.record(host(1), { a: { cpuPercent: null, memBytes: 0, players: { online: 3, max: 10 } } });
    expect(h.view().peaks.playersToday).toBe(3);
  });
});
