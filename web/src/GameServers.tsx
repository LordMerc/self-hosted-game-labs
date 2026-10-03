import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type Network, type OtherPanelServer, type Server, type Stats, type Template } from "./api";
import { Backups } from "./Backups";
import { CopyButton } from "./CopyButton";
import { CustomDialog } from "./CustomDialog";
import { DeployDialog } from "./DeployDialog";
import { HiddenIp, isIpAddress } from "./HiddenIp";
import { Icon, type IconName } from "./Icons";
import { LogViewer } from "./LogViewer";
import { Nav, type Page } from "./Nav";
import { NetworkPanel } from "./NetworkPanel";

const statusLabel: Record<Server["status"], string> = {
  online: "Running",
  paused: "Paused",
  offline: "Stopped",
  deploying: "Deploying",
  updating: "Updating",
  error: "Error",
};

type Tab = "all" | "online" | "paused" | "offline" | "error";
const tabLabel: Record<Tab, string> = { all: "All", online: "Running", paused: "Paused", offline: "Stopped", error: "Error" };

function bytes(n: number) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1000 && i < units.length - 1) (n /= 1000), i++;
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}

const rate = (n: number) => `${bytes(n).replace(/(\d+)\.\d+/, "$1")}/s`;

type Tile = { label: string; tone: "blue" | "violet" | "cyan" | "none"; value: string | null; sub: string; fill?: number };

/** Host figures for the top row. Anything the backend cannot report stays an empty tile rather than an invented number. */
function players(servers: Stats["servers"] | undefined): Tile {
  const counts = Object.values(servers ?? {}).flatMap((u) => (u.players ? [u.players.online] : []));
  if (counts.length === 0) return { label: "Players online", tone: "none", value: null, sub: "Not reported yet" };
  return { label: "Players online", tone: "none", value: String(counts.reduce((a, b) => a + b, 0)), sub: `across ${counts.length} server${counts.length === 1 ? "" : "s"}` };
}

function hostTiles(host: Stats["host"] | null, servers?: Stats["servers"]): Tile[] {
  const none = "Not reported yet";
  const pct = (used: number, total: number) => (total > 0 ? Math.min(100, (used / total) * 100) : 0);
  const cpu = host?.cpu.percent;
  return [
    { label: "CPU", tone: "blue", value: cpu == null ? null : `${Math.round(cpu)}%`, sub: cpu == null ? none : `${host!.cpu.cores} cores`, fill: cpu ?? undefined },
    {
      label: "Memory",
      tone: "violet",
      value: host?.memory ? bytes(host.memory.usedBytes) : null,
      sub: host?.memory ? `of ${bytes(host.memory.totalBytes)}` : none,
      fill: host?.memory ? pct(host.memory.usedBytes, host.memory.totalBytes) : undefined,
    },
    {
      label: "Storage",
      tone: "cyan",
      value: host?.storage ? bytes(host.storage.usedBytes) : null,
      sub: host?.storage ? `of ${bytes(host.storage.totalBytes)} used` : none,
      fill: host?.storage ? pct(host.storage.usedBytes, host.storage.totalBytes) : undefined,
    },
    {
      label: "Network",
      tone: "none",
      value: host?.network ? `↓ ${rate(host.network.rxPerSec)}` : null,
      sub: host?.network ? `↑ ${rate(host.network.txPerSec)}` : none,
    },
    players(servers),
  ];
}

const gameTones = ["green", "orange", "teal", "violet", "amber", "red"] as const;

/** Stable colour per game so a server keeps its icon tint between reloads. */
function gameTone(templateId: string) {
  let h = 0;
  for (const c of templateId) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return gameTones[h % gameTones.length];
}

export function GameIcon({ id, name }: { id: string; name: string }) {
  return <span className={`game-icon tone-${gameTone(id)}`}>{name.charAt(0).toUpperCase()}</span>;
}

function IconButton({ icon, label, onClick, disabled, danger }: { icon: IconName; label: string; onClick: () => void; disabled?: boolean; danger?: boolean }) {
  return (
    <button className={`icon-btn round${danger ? " danger" : ""}`} title={label} aria-label={label} onClick={onClick} disabled={disabled}>
      <Icon name={icon} size={15} />
    </button>
  );
}

export function GameServers({ onLogout, onNavigate, onOpenServer }: { onLogout: () => void; onNavigate: (p: Page) => void; onOpenServer: (id: string) => void }) {
  const [servers, setServers] = useState<Server[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [network, setNetwork] = useState<Network | null>(null);
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

  const refresh = useCallback(async () => {
    setServers(await api<Server[]>("/servers"));
    api<Network>("/network").then(setNetwork).catch(() => undefined);
    api<OtherPanelServer[]>("/other-panels").then(setOthers).catch(() => undefined);
  }, []);

  useEffect(() => {
    void refresh();
    api<Template[]>("/templates").then(setTemplates);
  }, [refresh]);

  const busy = servers.some((s) => s.status === "deploying" || s.status === "updating");
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
    const c: Record<Tab, number> = { all: servers.length, online: 0, paused: 0, offline: 0, error: 0 };
    for (const s of servers) if (s.status in c) c[s.status as Tab]++;
    return c;
  }, [servers]);
  const tabs = (["all", "online", "paused", "offline"] as Tab[]).concat(counts.error > 0 ? ["error"] : []);

  const shown = servers.filter((s) => {
    if (tab !== "all" && s.status !== tab) return false;
    const q = query.trim().toLowerCase();
    return !q || [s.name, s.templateName, s.connect.public, s.connect.lan].some((v) => v?.toLowerCase().includes(q));
  });
  const maxPlayers = (s: Server) => templates.find((t) => t.id === s.templateId)?.maxPlayers;
  const problems = network?.reconcile.problems ?? [];

  return (
    <div className="shell">
      <Nav page="servers" onNavigate={onNavigate} onLogout={onLogout} />

      <main className="content">
        <header className="page-head">
          <div>
            <h1>Game servers</h1>
          </div>
          <button className="primary with-icon" onClick={() => templatesRef.current?.scrollIntoView({ behavior: "smooth" })}>
            <Icon name="plus" size={16} />
            New server
          </button>
        </header>
        {message && <p className="error banner">{message}</p>}

        <section className="stats" aria-label="Host">
          {hostTiles(stats?.host ?? null, stats?.servers).map((t) => (
            <div key={t.label} className="stat">
              <span className="stat-label">{t.label}</span>
              <span className={`stat-value${t.value === null ? " pending" : ""}`}>{t.value ?? "—"}</span>
              {t.tone !== "none" && <span className={`stat-bar tone-${t.tone}`} style={{ "--fill": `${t.fill ?? 0}%` } as React.CSSProperties} />}
              <span className="stat-sub">{t.sub}</span>
            </div>
          ))}
        </section>

        <div className="layout">
          <div className="main-col">
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
                <input placeholder="Search servers" value={query} onChange={(e) => setQuery(e.target.value)} />
              </label>
            </div>

            {servers.length === 0 ? (
              <p className="empty">No servers yet. Pick a template below to deploy your first one.</p>
            ) : shown.length === 0 ? (
              <p className="empty">No servers match.</p>
            ) : (
              <div className="table-wrap">
                <table className="servers">
                  <thead>
                    <tr>
                      <th>Server</th>
                      <th>Status</th>
                      <th>Address</th>
                      <th>Ports</th>
                      <th>Access</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((s) => {
                      const primary = s.connect.public ?? s.connect.lan;
                      const max = maxPlayers(s);
                      const live = stats?.servers[s.id]?.players;
                      const locked = s.status === "deploying" || s.status === "updating";
                      return (
                        <tr key={s.id}>
                          <td>
                            <div className="server-cell">
                              <GameIcon id={s.templateId} name={s.templateName} />
                              <div>
                                <button className="server-link" onClick={() => onOpenServer(s.id)} title="Open settings and console">{s.name}</button>
                                <div className="muted">{s.templateName}</div>
                              </div>
                            </div>
                          </td>
                          <td>
                            <span className={`status ${s.starting ? "deploying" : s.status}`} title={s.starting ? "The game is still loading or downloading; it will say Running once it is ready to join" : undefined}>
                              <span className={`dot ${s.starting ? "deploying" : s.status}`} /> {s.starting ? "Starting" : statusLabel[s.status]}
                            </span>
                            {(live || max !== undefined) && (
                              <div className="muted players" title={live ? "Players connected right now" : "This game does not report live player counts yet"}>
                                <Icon name="users" size={13} /> {live ? `${live.online} / ${live.max || max || "?"}` : `up to ${max}`}
                              </div>
                            )}
                            {stats?.servers[s.id] && (
                              <div className="muted usage" title="Share of the whole host's CPU, and memory in use">
                                {stats.servers[s.id].cpuPercent == null ? "CPU —" : `CPU ${stats.servers[s.id].cpuPercent!.toFixed(stats.servers[s.id].cpuPercent! < 10 ? 1 : 0)}%`} · {bytes(stats.servers[s.id].memBytes)}
                              </div>
                            )}
                            {s.lastError && <div className="error small-text">{s.lastError}</div>}
                          </td>
                          <td>
                            <div className="address">
                              <div>
                                <div className={`mono addr-main${s.access === "private" ? " dim" : ""}`}>
                                  {primary && isIpAddress(primary) && primary === s.connect.public ? <HiddenIp value={primary} /> : (primary ?? "—")}
                                </div>
                                {s.connect.public && s.connect.lan && <div className="mono muted addr-sub">LAN {s.connect.lan}</div>}
                                {s.connect.instructions && <div className="muted small-text wrap">{s.connect.instructions}</div>}
                                {s.access === "public" && s.pendingRules.length === 0 && (
                                  s.reachability ? (
                                    <div className={`small-text ${s.reachability.state === "problem" ? "warn" : "muted"}`} title={`Checked ${new Date(s.reachability.at).toLocaleTimeString()}. Use External port check in the Network panel to check again.`}>
                                      <span className={`dot ${s.reachability.state === "problem" ? "error" : s.reachability.state === "unknown" ? "paused" : "online"}`} /> {s.reachability.text}
                                    </div>
                                  ) : (
                                    <div className="muted small-text" title="Press Run under External port check in the Network panel, or check from a phone on cellular data.">
                                      Reachability untested
                                    </div>
                                  )
                                )}
                                {s.access === "public" && s.pendingRules.length > 0 && (
                                  <div className="warn small-text">Waiting for router rule(s): confirm in the Network panel</div>
                                )}
                              </div>
                              {primary && <CopyButton text={primary} label="Copy address" />}
                            </div>
                          </td>
                          <td>
                            <div className="chips">
                              {s.ports.map((p) => (
                                <span key={`${p.port}${p.protocol}`} className="chip mono">
                                  {p.port} <span className="proto">{p.protocol.toUpperCase()}</span>
                                </span>
                              ))}
                            </div>
                          </td>
                          <td>
                            <div className="seg">
                              <button
                                className={s.access === "private" ? "on" : ""}
                                disabled={locked || s.access === "private"}
                                onClick={() => act(api(`/servers/${s.id}/access`, { method: "PUT", body: { access: "private" } }))}
                              >
                                <Icon name="lock" size={13} /> Private
                              </button>
                              <button
                                className={s.access === "public" ? "on public" : ""}
                                disabled={locked || s.status === "error" || s.access === "public"}
                                onClick={() => act(api(`/servers/${s.id}/access`, { method: "PUT", body: { access: "public" } }))}
                              >
                                <Icon name="globe" size={13} /> Public
                              </button>
                            </div>
                          </td>
                          <td>
                            <div className="actions">
                              {s.status === "error" ? (
                                <IconButton icon="play" label="Retry" onClick={() => act(api(`/servers/${s.id}/retry`, { method: "POST" }))} />
                              ) : s.status === "online" ? (
                                <IconButton icon="pause" label="Stop" onClick={() => act(api(`/servers/${s.id}/stop`, { method: "POST" }))} />
                              ) : (
                                <IconButton icon="play" label="Start" disabled={locked} onClick={() => act(api(`/servers/${s.id}/start`, { method: "POST" }))} />
                              )}
                              <IconButton icon="restart" label="Restart" disabled={s.status !== "online"} onClick={() => act(api(`/servers/${s.id}/restart`, { method: "POST" }))} />
                              <IconButton icon="terminal" label="Logs" disabled={locked} onClick={() => setLogsFor(s)} />
                              <IconButton icon="archive" label="Backups" disabled={locked} onClick={() => setBackupsFor(s)} />
                              {s.secrets.length === 0 && <span className="icon-slot" />}
                              {s.secrets.length > 0 && (
                                <details className="menu">
                                  <summary className="icon-btn round" title="Passwords" aria-label="Passwords">
                                    <Icon name="key" size={15} />
                                  </summary>
                                  <div className="menu-items">
                                    {s.secrets.map((k) => (
                                      <button key={k} className="link" onClick={() => reveal(s, k)}>
                                        Show {k.toLowerCase().replace(/_/g, " ")}
                                      </button>
                                    ))}
                                  </div>
                                </details>
                              )}
                              <IconButton icon="trash" label="Delete" danger onClick={() => remove(s)} />
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {problems.length > 0 && (
              <p className="note warn">
                <Icon name="shield" size={15} /> {problems.length === 1 ? problems[0] : `${problems.length} things need attention. See the Network panel.`}
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

            <section ref={templatesRef} className="deploy">
              <div className="deploy-head">
                <h2>Deploy a new server</h2>
                <span className="muted">One-click templates · Docker</span>
              </div>
              <div className="templates">
                {templates.map((t) => (
                  <button key={t.id} className="template" onClick={() => setDeploying(t)}>
                    <GameIcon id={t.id} name={t.name} />
                    <strong>{t.name}</strong>
                  </button>
                ))}
                <button className="template custom" onClick={() => setCustomOpen(true)}>
                  <span className="game-icon tone-custom">+</span>
                  <strong>Custom Docker image</strong>
                </button>
              </div>
            </section>
          </div>

          <NetworkPanel network={network} servers={servers} onChange={refresh} />
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
