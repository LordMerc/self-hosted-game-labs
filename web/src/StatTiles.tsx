import type { Server, Stats, Template } from "./api";
import { bytes, rate } from "./format";
import { Spark } from "./Spark";
import { Skel } from "./Skeleton";

const pct = (used: number, total: number) => (total > 0 ? Math.min(100, (used / total) * 100) : 0);

function Tile({ label, value, children, sub, loading }: { label: string; value: string | null; children?: React.ReactNode; sub: string; loading?: boolean }) {
  if (loading) {
    return (
      <div className="stat" aria-busy="true">
        <span className="stat-label">{label}</span>
        <Skel w="5rem" className="skel-value" />
        <Skel w="100%" h="var(--spark-h)" />
        <Skel w="70%" h="0.8rem" />
      </div>
    );
  }
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className={`stat-value${value === null ? " pending" : ""}`}>{value ?? "—"}</span>
      {children}
      <span className="stat-sub" title={sub}>{sub}</span>
    </div>
  );
}

/**
 * The five figures along the top. Anything the host cannot report stays an empty tile rather than an invented number, and the
 * small charts and peaks come only from what the panel has actually measured (the last few minutes, or today for players).
 */
export function StatTiles({ stats, servers, templates }: { stats: Stats | null; servers: Server[]; templates: Template[] }) {
  const loading = stats === null; // nothing yet (first visit): placeholders, rather than "Not reported yet" tiles
  const host = stats?.host;
  const hist = stats?.history;
  const none = "Not reported yet";
  const minutes = hist?.peaks.windowMinutes ?? 15;
  const cpu = host?.cpu.percent;
  const cpuPeak = hist?.peaks.cpuPercent;

  const counts = Object.entries(stats?.servers ?? {}).flatMap(([, u]) => (u.players ? [u.players] : []));
  const online = counts.reduce((a, b) => a + b.online, 0);
  const slots = counts.every((c) => c.max > 0) ? counts.reduce((a, b) => a + b.max, 0) : 0; // a server that does not report its limit makes the total unknowable
  const peakToday = hist?.peaks.playersToday;
  // Only games the panel can ask count towards the tile. When every running game is one it cannot ask, say that rather than "not reported yet".
  const running = servers.filter((s) => s.status === "online");
  const askable = running.filter((s) => templates.find((t) => t.id === s.templateId)?.reportsPlayers !== false);
  const noneAskable = running.length > 0 && askable.length === 0;
  const playersNone = noneAskable ? "No running game reports players" : none;

  return (
    <section className="stats" aria-label="Host">
      <Tile loading={loading} label="CPU" value={cpu == null ? null : `${Math.round(cpu)}%`} sub={cpu == null ? none : `${host!.cpu.cores} cores${cpuPeak != null ? ` · peak ${Math.round(cpuPeak)}% (${minutes} min)` : ""}`}>
        <Spark values={hist?.host.cpu ?? []} floor={20} tone="var(--stat-cpu)" label={`CPU over the last ${minutes} minutes`} />
      </Tile>
      <Tile loading={loading} label="Memory" value={host?.memory ? bytes(host.memory.usedBytes) : null} sub={host?.memory ? `of ${bytes(host.memory.totalBytes)} · ${Math.round(pct(host.memory.usedBytes, host.memory.totalBytes))}%` : none}>
        <Spark values={hist?.host.mem ?? []} max={host?.memory?.totalBytes} tone="var(--stat-memory)" label={`Memory in use over the last ${minutes} minutes`} />
      </Tile>
      <Tile loading={loading} label="Storage" value={host?.storage ? bytes(host.storage.usedBytes) : null} sub={host?.storage ? `of ${bytes(host.storage.totalBytes)} · ${Math.round(pct(host.storage.usedBytes, host.storage.totalBytes))}% used` : none}>
        <Spark values={hist?.host.storage ?? []} max={host?.storage?.totalBytes} tone="var(--stat-storage)" label={`Storage in use over the last ${minutes} minutes`} />
      </Tile>
      <Tile loading={loading} label="Network" value={host?.network ? `↓ ${rate(host.network.rxPerSec)}` : null} sub={host?.network ? `↑ ${rate(host.network.txPerSec)}` : none}>
        <Spark values={hist?.host.rx ?? []} floor={10_000} tone="var(--stat-network)" label={`Download over the last ${minutes} minutes`} />
      </Tile>
      <Tile
        loading={loading}
        label="Players online"
        value={counts.length === 0 ? null : String(online)}
        sub={counts.length === 0 ? playersNone : `${slots > 0 ? `of ${slots} slots` : `across ${counts.length} server${counts.length === 1 ? "" : "s"}`}${peakToday != null ? ` · peak ${peakToday} today` : ""}`}
      >
        <Spark values={hist?.host.players ?? []} floor={4} tone="var(--stat-players)" label={`Players over the last ${minutes} minutes`} />
      </Tile>
    </section>
  );
}
