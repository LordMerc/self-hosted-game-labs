import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, loadTemplates, type ActivityItem, type Network, type OtherPanelServer, type Server, type Stats, type Template } from "./api";
import { Backups } from "./Backups";
import { CustomDialog } from "./CustomDialog";
import { DeployCards } from "./DeployCards";
import { DeployDialog } from "./DeployDialog";
import { uptime } from "./format";
import { Icon } from "./Icons";
import { LogViewer } from "./LogViewer";
import { Nav, type Page } from "./Nav";
import { NetworkPanel } from "./NetworkPanel";
import { ServersTable } from "./ServersTable";
import { StatTiles } from "./StatTiles";
import { UpdateBanner } from "./UpdateNotice";

export { GameIcon } from "./GameIcon";

type Tab = "all" | "online" | "paused" | "offline" | "error";
const tabLabel: Record<Tab, string> = { all: "All", online: "Running", paused: "Paused", offline: "Stopped", error: "Problems" };

/** "homelab-01 · 8 cores · Docker 27.3 · up 23 days": whatever of that the host and Docker could tell us. */
function hostLine(stats: Stats | null) {
  if (!stats) return null;
  const parts = [
    stats.docker?.name || null,
    `${stats.host.cpu.cores} core${stats.host.cpu.cores === 1 ? "" : "s"}`,
    stats.docker?.version ? `Docker ${stats.docker.version.split(".").slice(0, 2).join(".")}` : null,
    stats.host.uptimeSec != null ? `up ${uptime(stats.host.uptimeSec)}` : null,
  ].filter(Boolean);
  return parts.join(" · ");
}

export function GameServers({ onLogout, onNavigate, onOpenServer }: { onLogout: () => void; onNavigate: (p: Page) => void; onOpenServer: (id: string) => void }) {
  const [servers, setServers] = useState<Server[] | null>(null);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [network, setNetwork] = useState<Network | null>(null);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [deploying, setDeploying] = useState<Template | null>(null);
  const [customOpen, setCustomOpen] = useState(false);
  const [logsFor, setLogsFor] = useState<Server | null>(null);
  const [backupsFor, setBackupsFor] = useState<Server | null>(null);
  const [message, setMessage] = useState("");
  const [stats, setStats] = useState<Stats | null>(null);
  const [others, setOthers] = useState<OtherPanelServer[]>([]);
  const [tab, setTab] = useState<Tab>("all");
  const [query, setQuery] = useState("");
  const templatesRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    setServers(await api<Server[]>("/servers"));
    api<Network>("/network").then(setNetwork).catch(() => undefined);
    api<OtherPanelServer[]>("/other-panels").then(setOthers).catch(() => undefined);
    api<ActivityItem[]>("/activity").then(setActivity).catch(() => undefined);
  }, []);

  useEffect(() => {
    void refresh();
    loadTemplates().then(setTemplates);
  }, [refresh]);

  const list = servers ?? [];
  const busy = list.some((s) => s.status === "deploying" || s.status === "updating");
  useEffect(() => {
    const t = setInterval(() => void refresh(), busy ? 2500 : 15000);
    return () => clearInterval(t);
  }, [busy, refresh]);

  // Poll one request at a time: Docker takes a second or two to answer a stats call.
  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const next = await api<Stats>("/stats");
        if (!stop) setStats(next);
      } catch {
        /* keep the last numbers; the page-level poll reports real outages */
      }
      if (!stop) timer = setTimeout(tick, 5000);
    };
    void tick();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, []);

  // "/" jumps to the search box, as the hint in it says (unless you are already typing somewhere).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable) return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  async function act(promise: Promise<unknown>) {
    setMessage("");
    try {
      await promise;
    } catch (e) {
      setMessage((e as Error).message);
    }
    await refresh();
  }

  async function remove(s: Server) {
    if (!confirm(`Delete ${s.name}? The container is removed; world data and backups are kept on disk.`)) return;
    await act(api(`/servers/${s.id}`, { method: "DELETE" }));
  }

  async function reveal(s: Server, key: string) {
    const { value } = await api<{ value: string }>(`/servers/${s.id}/secrets/${key}`);
    alert(`${key}\n\n${value || "(empty)"}`);
  }

  const counts = useMemo(() => {
    const c: Record<Tab, number> = { all: list.length, online: 0, paused: 0, offline: 0, error: 0 };
    for (const s of list) if (s.status in c) c[s.status as Tab]++;
    return c;
  }, [list]);
  const tabs = (["all", "online"] as Tab[]).concat(counts.paused > 0 ? ["paused"] : [], ["offline"], counts.error > 0 ? ["error"] : []);

  const shown = list.filter((s) => {
    if (tab !== "all" && s.status !== tab) return false;
    const q = query.trim().toLowerCase();
    return !q || [s.name, s.templateName, s.connect.public, s.connect.lan].some((v) => v?.toLowerCase().includes(q));
  });
  const problems = network?.reconcile.problems ?? [];
  const line = hostLine(stats);
  const first = servers !== null && list.length === 0;

  return (
    <div className="shell">
      <Nav page="servers" onNavigate={onNavigate} onLogout={onLogout} />

      <main className="content">
        <header className="page-head">
          <div>
            {line && (
              <p className="host-line">
                <span className="dot online" /> {line}
              </p>
            )}
            <h1>Game servers</h1>
          </div>
          <button className="primary with-icon" onClick={() => templatesRef.current?.scrollIntoView({ behavior: "smooth" })}>
            <Icon name="plus" size={16} />
            New server
          </button>
        </header>
        <UpdateBanner />
        {message && <p className="error banner">{message}</p>}

        <StatTiles stats={stats} />

        <div className="layout">
          <div className="main-col">
            {!first && (
              <div className="toolbar">
                <div className="tabs" role="tablist">
                  {tabs.map((t) => (
                    <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>
                      {tabLabel[t]} <span className="count">{counts[t]}</span>
                    </button>
                  ))}
                </div>
                <label className="search">
                  <Icon name="search" size={15} />
                  <input ref={searchRef} placeholder="Search servers" aria-label="Search servers" aria-keyshortcuts="/" value={query} onChange={(e) => setQuery(e.target.value)} />
                  <kbd aria-hidden="true">/</kbd>
                </label>
              </div>
            )}

            {first ? (
              <div className="empty-hero">
                <span className="empty-mark">
                  <Icon name="server" size={22} />
                </span>
                <h2>No servers yet</h2>
                <p className="muted">Your first one is a few clicks away. Pick a template below.</p>
              </div>
            ) : shown.length === 0 && servers !== null ? (
              <p className="empty">No servers match.</p>
            ) : (
              <ServersTable
                servers={shown}
                templates={templates}
                stats={stats}
                network={network}
                act={act}
                onOpenServer={onOpenServer}
                onLogs={setLogsFor}
                onBackups={setBackupsFor}
                onDelete={remove}
                onReveal={reveal}
              />
            )}

            {problems.length > 0 && (
              <p className="note warn">
                <Icon name="shield" size={15} /> {problems.length === 1 ? problems[0] : `${problems.length} things need attention. See Network health.`}
              </p>
            )}

            {others.length > 0 && (
              <section className="others">
                <h2>Run by another panel</h2>
                <p className="muted">These belong to a different Game Labs panel on this machine. You can see them here, but this panel never starts, stops, changes or deletes them.</p>
                <ul>
                  {others.map((o) => (
                    <li key={o.name}>
                      <strong>{o.slug || o.name}</strong> <span className="instance-badge">{o.instance}</span>
                      <span className="muted">
                        {" "}
                        {o.state === "running" ? "Running" : o.state === "paused" ? "Paused" : "Stopped"} · {o.image}
                        {o.ports.length > 0 && ` · ${[...new Set(o.ports.map((p) => `${p.port}/${p.protocol}`))].join(", ")}`}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <section ref={templatesRef} className={`deploy${first ? " hero" : ""}`}>
              <DeployCards templates={templates} servers={list} hero={first} onPick={setDeploying} onCustom={() => setCustomOpen(true)} />
            </section>
          </div>

          <NetworkPanel network={network} servers={list} activity={activity} onChange={refresh} />
        </div>
      </main>

      {deploying && (
        <DeployDialog
          template={deploying}
          onClose={() => setDeploying(null)}
          onDeployed={() => {
            setDeploying(null);
            void refresh();
          }}
        />
      )}
      {customOpen && (
        <CustomDialog
          onClose={() => setCustomOpen(false)}
          onDeployed={() => {
            setCustomOpen(false);
            void refresh();
          }}
        />
      )}
      {backupsFor && <Backups id={backupsFor.id} name={backupsFor.name} running={backupsFor.status === "online"} onClose={() => setBackupsFor(null)} onChange={() => void refresh()} />}
      {logsFor && <LogViewer id={logsFor.id} name={logsFor.name} onClose={() => setLogsFor(null)} />}
    </div>
  );
}
