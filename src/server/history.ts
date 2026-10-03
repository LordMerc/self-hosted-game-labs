import { eq } from "drizzle-orm";
import type { Db } from "./db/index.js";
import { schema } from "./db/index.js";
import type { HostSnapshot } from "./host-stats.js";

export type ServerSample = { cpuPercent: number | null; memBytes: number; players: { online: number; max: number } | null };

export interface HistoryView {
  /** Seconds between points. */
  intervalSec: number;
  host: { cpu: (number | null)[]; mem: (number | null)[]; storage: (number | null)[]; rx: (number | null)[]; tx: (number | null)[]; players: (number | null)[] };
  /** Per running server, same length and spacing as the host series (null where the server was not running or gave no figure). */
  servers: Record<string, { cpu: (number | null)[]; memBytes: (number | null)[]; players: (number | null)[] }>;
  peaks: { cpuPercent: number | null; playersToday: number | null; windowMinutes: number };
}

/** Somewhere to keep the one value that must survive a restart: the highest player count seen today. */
export interface PeakStore {
  load(): string | null;
  save(value: string): void;
}

/**
 * The last few minutes of host and per-server figures, for the dashboard's small charts. Held in memory only: a restart
 * starts the charts empty, which is honest, since nothing was measured while the panel was down. The one thing kept on disk
 * is today's highest player count, through `store`.
 */
export class StatsHistory {
  private host = { cpu: [] as (number | null)[], mem: [] as (number | null)[], storage: [] as (number | null)[], rx: [] as (number | null)[], tx: [] as (number | null)[], players: [] as (number | null)[] };
  private servers = new Map<string, { cpu: (number | null)[]; memBytes: (number | null)[]; players: (number | null)[] }>();

  constructor(
    private readonly opts: { max?: number; intervalSec?: number; store?: PeakStore; today?: () => string } = {},
  ) {}

  private get max() {
    return this.opts.max ?? 45;
  }
  private get intervalSec() {
    return this.opts.intervalSec ?? 20;
  }
  private today() {
    return this.opts.today?.() ?? new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD in the host's time zone
  }

  private push<T>(list: T[], v: T) {
    list.push(v);
    if (list.length > this.max) list.splice(0, list.length - this.max);
  }

  record(host: HostSnapshot, servers: Record<string, ServerSample>) {
    this.push(this.host.cpu, host.cpu.percent);
    this.push(this.host.mem, host.memory?.usedBytes ?? null);
    this.push(this.host.storage, host.storage?.usedBytes ?? null);
    this.push(this.host.rx, host.network?.rxPerSec ?? null);
    this.push(this.host.tx, host.network?.txPerSec ?? null);
    const reported = Object.values(servers).flatMap((s) => (s.players ? [s.players.online] : []));
    const total = reported.length > 0 ? reported.reduce((a, b) => a + b, 0) : null;
    this.push(this.host.players, total);
    if (total !== null) this.notePeak(total);

    for (const id of [...this.servers.keys()]) if (!(id in servers)) this.servers.delete(id);
    for (const [id, s] of Object.entries(servers)) {
      let h = this.servers.get(id);
      if (!h) {
        // A server that started mid-window: pad so every series lines up with the host's.
        const pad = () => Array<number | null>(Math.max(0, this.host.cpu.length - 1)).fill(null);
        h = { cpu: pad(), memBytes: pad(), players: pad() };
        this.servers.set(id, h);
      }
      this.push(h.cpu, s.cpuPercent);
      this.push(h.memBytes, s.memBytes);
      this.push(h.players, s.players?.online ?? null);
    }
  }

  private notePeak(total: number) {
    const store = this.opts.store;
    if (!store) return;
    const day = this.today();
    try {
      const saved = JSON.parse(store.load() ?? "null") as { day?: string; peak?: number } | null;
      const peak = saved?.day === day && typeof saved.peak === "number" ? saved.peak : 0;
      if (total > peak || saved?.day !== day) store.save(JSON.stringify({ day, peak: Math.max(total, peak) }));
    } catch {
      /* a bad stored value is replaced on the next sample */
      store.save(JSON.stringify({ day, peak: total }));
    }
  }

  private playersToday(): number | null {
    const store = this.opts.store;
    if (!store) return null;
    try {
      const saved = JSON.parse(store.load() ?? "null") as { day?: string; peak?: number } | null;
      return saved?.day === this.today() && typeof saved.peak === "number" ? saved.peak : null;
    } catch {
      return null;
    }
  }

  view(): HistoryView {
    const cpu = this.host.cpu.filter((v): v is number => v !== null);
    return {
      intervalSec: this.intervalSec,
      host: { cpu: [...this.host.cpu], mem: [...this.host.mem], storage: [...this.host.storage], rx: [...this.host.rx], tx: [...this.host.tx], players: [...this.host.players] },
      servers: Object.fromEntries([...this.servers].map(([id, s]) => [id, { cpu: [...s.cpu], memBytes: [...s.memBytes], players: [...s.players] }])),
      peaks: {
        cpuPercent: cpu.length > 0 ? Math.max(...cpu) : null,
        playersToday: this.playersToday(),
        windowMinutes: Math.round((this.max * this.intervalSec) / 60),
      },
    };
  }
}

const PEAK_KEY = "players-peak-today";

/** Keeps the daily player peak in the existing settings table, so it needs no migration. */
export function settingsPeakStore(db: Db): PeakStore {
  return {
    load: () => db.select().from(schema.settings).where(eq(schema.settings.key, PEAK_KEY)).get()?.value ?? null,
    save: (value) => void db.insert(schema.settings).values({ key: PEAK_KEY, value }).onConflictDoUpdate({ target: schema.settings.key, set: { value } }).run(),
  };
}
