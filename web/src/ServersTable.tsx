import { useState } from "react";
import { api, type Network, type Server, type Stats, type Template } from "./api";
import { ago, bytes } from "./format";
import { CopyButton } from "./CopyButton";
import { GameIcon } from "./GameIcon";
import { HiddenIp, isIpAddress } from "./HiddenIp";
import { Icon } from "./Icons";
import { limitText } from "./Limits";
import { RowMenu, type MenuItem } from "./RowMenu";

type StatusKey = "running" | "starting" | "stopped" | "paused" | "crashed" | "failed" | "deploying" | "updating";

/** What the Status column says. A running container whose game port is not open yet is "Starting"; one that vanished from Docker is "Crashed". */
export function statusOf(s: Pick<Server, "status" | "starting" | "lastError">): { key: StatusKey; label: string; hint?: string } {
  if (s.status === "error") return /missing from docker/i.test(s.lastError ?? "") ? { key: "crashed", label: "Crashed", hint: "The container is gone from Docker" } : { key: "failed", label: "Failed", hint: s.lastError ?? undefined };
  if (s.status === "online" && s.starting) return { key: "starting", label: "Starting", hint: "The game is still loading or downloading; it will say Running once it is ready to join" };
  return { online: { key: "running", label: "Running" }, offline: { key: "stopped", label: "Stopped" }, paused: { key: "paused", label: "Paused" }, deploying: { key: "deploying", label: "Deploying" }, updating: { key: "updating", label: "Updating" } }[s.status] as { key: StatusKey; label: string };
}

export function StatusPill({ server }: { server: Pick<Server, "status" | "starting" | "lastError"> }) {
  const st = statusOf(server);
  return (
    <span className={`pill ${st.key}`} title={st.hint}>
      <span className="pill-dot" /> {st.label}
    </span>
  );
}

const reachWord = { ok: "Reachable", forwarded: "Forwarded", problem: "Problem", unknown: "Unknown" } as const;

/** "Checked 2h ago", the way a saved outside-check answer is dated. */
export const checkedAgo = (at: string) => {
  const t = ago(at);
  return t === "now" ? "Checked just now" : `Checked ${t} ago`;
};

const staleWhy = { "ip-changed": "Your public IP changed since, so this may be out of date.", old: "More than a day old, so this may be out of date." } as const;

function Access({ s, canTest, testing, onTest }: { s: Server; canTest: boolean; testing: boolean; onTest: () => void }) {
  const pub = s.access === "public";
  const r = s.reachability;
  return (
    <div className="access">
      <span className={`access-chip ${pub ? "public" : "private"}`}>
        <Icon name={pub ? "globe" : "lock"} size={13} /> {pub ? "Public" : "Private"}
      </span>
      {!pub && <span className="access-line muted">LAN only</span>}
      {pub && s.pendingRules.length > 0 && <span className="access-line warn">Waiting for router rule</span>}
      {pub && s.pendingRules.length === 0 && r && (
        <span className={`access-line ${r.state === "problem" ? "bad" : r.state === "unknown" ? "warn" : "good"}`} title={`${r.text}. Checked ${new Date(r.at).toLocaleTimeString()}.`}>
          <Icon name={r.state === "problem" ? "alert" : r.state === "unknown" ? "info" : "check"} size={13} /> {reachWord[r.state]}
        </span>
      )}
      {pub && s.pendingRules.length === 0 && r && <span className="access-text muted">{checkedAgo(r.at)}</span>}
      {pub && s.pendingRules.length === 0 && r?.stale && <span className="access-text warn">{staleWhy[r.stale]}</span>}
      {pub && s.pendingRules.length === 0 && r?.state === "problem" && <span className="access-text bad">{r.text}</span>}
      {pub && s.pendingRules.length === 0 && r?.attempt && <span className="access-text muted">{`The last test could not finish: ${r.attempt.text}`}</span>}
      {pub && s.pendingRules.length === 0 && !r && <span className="access-line warn">Untested</span>}
      {pub && s.pendingRules.length === 0 && canTest && s.status !== "error" && (
        <button className="text-btn" onClick={onTest} disabled={testing} aria-label={`Test ${s.name} from outside`} title="Ask an outside service to try this server's ports. UDP ports cannot be tested that way; for those the panel shows whether the router forwards them.">
          {testing ? "Testing…" : r ? "Test again" : "Test"}
        </button>
      )}
    </div>
  );
}

export function ServersTable({
  servers,
  templates,
  stats,
  network,
  act,
  onOpenServer,
  onLogs,
  onBackups,
  onConnect,
  onDelete,
  onReveal,
}: {
  servers: Server[];
  templates: Template[];
  stats: Stats | null;
  network: Network | null;
  act: (p: Promise<unknown>) => Promise<void>;
  onOpenServer: (id: string) => void;
  onLogs: (s: Server) => void;
  onBackups: (s: Server) => void;
  onConnect: (s: Server) => void;
  onDelete: (s: Server) => void;
  onReveal: (s: Server, key: string) => void;
}) {
  const [testing, setTesting] = useState<string | null>(null);
  const post = (s: Server, what: string) => act(api(`/servers/${s.id}/${what}`, { method: "POST" }));
  const maxPlayers = (s: Server) => templates.find((t) => t.id === s.templateId)?.maxPlayers;

  async function test(s: Server) {
    setTesting(s.id);
    await act(api("/network/port-check", { method: "POST", body: { serverId: s.id } }));
    setTesting(null);
  }

  return (
    <div className="table-wrap">
      <table className="servers">
        <thead>
          <tr>
            <th>Server</th>
            <th>Status</th>
            <th>Address</th>
            <th className="col-ports">Ports</th>
            <th>Access</th>
            <th>
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {servers.map((s) => {
            const primary = s.connect.public ?? s.connect.lan;
            const max = maxPlayers(s);
            const live = stats?.servers[s.id]?.players;
            const use = stats?.servers[s.id];
            const locked = s.status === "deploying" || s.status === "updating";
            const st = statusOf(s);
            const items: MenuItem[] = [
              { label: "Restart", icon: "restart", disabled: s.status !== "online", onSelect: () => void post(s, "restart") },
              { label: "Backups…", icon: "archive", disabled: locked, onSelect: () => onBackups(s) },
              { label: "How to connect…", icon: "info", onSelect: () => onConnect(s) },
              ...s.secrets.map((k) => ({ label: `Show ${k.toLowerCase().replace(/_/g, " ")}`, icon: "key" as const, onSelect: () => onReveal(s, k) })),
              { label: "Settings and console", icon: "settings2", onSelect: () => onOpenServer(s.id) },
              s.access === "public"
                ? { label: "Make private", icon: "lock", disabled: locked, onSelect: () => void act(api(`/servers/${s.id}/access`, { method: "PUT", body: { access: "private" } })) }
                : { label: "Make public", icon: "globe", disabled: locked || s.status === "error", onSelect: () => void act(api(`/servers/${s.id}/access`, { method: "PUT", body: { access: "public" } })) },
              { label: "Delete server…", icon: "trash", danger: true, separated: true, onSelect: () => onDelete(s) },
            ];
            return (
              <tr key={s.id}>
                <td data-label="Server">
                  <div className="server-cell">
                    <GameIcon id={s.templateId} name={s.templateName} />
                    <div>
                      <button className="server-link" onClick={() => onOpenServer(s.id)} title="Open settings and console">
                        {s.name}
                      </button>
                      <div className="muted">
                        {s.templateName}
                        {s.update && (
                          <button className="chip update-chip" onClick={() => onOpenServer(s.id)} title="Open the server page to update it">
                            Update available: {s.update.to}
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                </td>
                <td data-label="Status">
                  <StatusPill server={s} />
                  {(live || max !== undefined) && (
                    <div className="muted players" title={live ? "Players connected right now" : "This game does not report live player counts yet"}>
                      <Icon name="users" size={13} /> {live ? `${live.online} / ${live.max || max || "?"} players` : `up to ${max} players`}
                    </div>
                  )}
                  {use && (
                    <div className="muted usage" title="Share of the whole host's CPU, and memory in use">
                      {use.cpuPercent == null ? "CPU —" : `CPU ${use.cpuPercent.toFixed(use.cpuPercent < 10 ? 1 : 0)}%`} · {bytes(use.memBytes)}
                    </div>
                  )}
                  {limitText(s.limits) && (
                    <div className="muted usage" title="The most CPU and memory this server may use. Change it on the server's page.">
                      Limit {limitText(s.limits)}
                    </div>
                  )}
                  {s.limits.warnings.map((w) => (
                    <div key={w} className="warn small-text wrap">
                      {w}
                    </div>
                  ))}
                  {s.lastError && <div className="error small-text">{s.lastError}</div>}
                </td>
                <td data-label="Address">
                  <div className="address">
                    <div>
                      <div className={`mono addr-main${s.access === "private" ? " dim" : ""}`}>{primary && isIpAddress(primary) && primary === s.connect.public ? <HiddenIp value={primary} /> : (primary ?? "—")}</div>
                      <div className="chips inline-ports">
                        {s.ports.map((p) => (
                          <span key={`${p.port}${p.protocol}`} className="chip mono">
                            {p.port} <span className="proto">{p.protocol.toUpperCase()}</span>
                          </span>
                        ))}
                      </div>
                    </div>
                    {primary && <CopyButton text={primary} label={`Copy ${s.name} address`} />}
                  </div>
                </td>
                <td data-label="Ports" className="col-ports">
                  <div className="chips">
                    {s.ports.map((p) => (
                      <span key={`${p.port}${p.protocol}`} className="chip mono">
                        {p.port} <span className="proto">{p.protocol.toUpperCase()}</span>
                      </span>
                    ))}
                  </div>
                </td>
                <td data-label="Access">
                  <Access s={s} canTest={network?.portCheck.enabled ?? false} testing={testing === s.id} onTest={() => void test(s)} />
                </td>
                <td className="col-actions">
                  <div className="actions">
                    {s.status === "error" ? (
                      <button className="act-btn" onClick={() => void post(s, "retry")} aria-label={`Retry ${s.name}`}>
                        <Icon name="restart" size={14} /> Retry
                      </button>
                    ) : s.status === "online" ? (
                      <button className="act-btn" onClick={() => void post(s, "stop")} aria-label={`Stop ${s.name}`}>
                        <Icon name="stop" size={14} /> Stop
                      </button>
                    ) : (
                      <button className="act-btn" disabled={locked} onClick={() => void post(s, "start")} aria-label={`Start ${s.name}`}>
                        <Icon name="play" size={14} /> {locked ? st.label : "Start"}
                      </button>
                    )}
                    <button className="icon-btn round" title={`Logs for ${s.name}`} aria-label={`Logs for ${s.name}`} disabled={locked} onClick={() => onLogs(s)}>
                      <Icon name="terminal" size={15} />
                    </button>
                    <RowMenu label={`More actions for ${s.name}`} items={items} />
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
