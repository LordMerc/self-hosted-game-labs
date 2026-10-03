import { useCallback, useEffect, useState } from "react";
import { api, type Network, type Server, type Template } from "./api";
import { DeployDialog } from "./DeployDialog";
import { LogViewer } from "./LogViewer";
import { NetworkPanel } from "./NetworkPanel";

const statusLabel: Record<Server["status"], string> = {
  online: "Online",
  paused: "Paused",
  offline: "Offline",
  deploying: "Deploying",
  updating: "Updating",
  error: "Error",
};

export function GameServers({ onLogout }: { onLogout: () => void }) {
  const [servers, setServers] = useState<Server[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [network, setNetwork] = useState<Network | null>(null);
  const [deploying, setDeploying] = useState<Template | null>(null);
  const [logsFor, setLogsFor] = useState<Server | null>(null);
  const [message, setMessage] = useState("");

  const refresh = useCallback(async () => {
    setServers(await api<Server[]>("/servers"));
    api<Network>("/network").then(setNetwork).catch(() => undefined);
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
    if (!confirm(`Delete ${s.name}? The container is removed; world data is kept on disk.`)) return;
    await act(api(`/servers/${s.id}`, { method: "DELETE" }));
  }

  async function reveal(s: Server, key: string) {
    const { value } = await api<{ value: string }>(`/servers/${s.id}/secrets/${key}`);
    alert(`${key}\n\n${value || "(empty)"}`);
  }

  return (
    <div className="shell">
      <aside className="nav">
        <div className="brand">Game Labs</div>
        <nav>
          <a className="active">Game servers</a>
        </nav>
        <button className="link" onClick={onLogout}>
          Sign out
        </button>
      </aside>

      <main className="content">
        <header>
          <h1>Game servers</h1>
        </header>
        {message && <p className="error banner">{message}</p>}

        <div className="layout">
          <div>
            <section className="card">
              {servers.length === 0 ? (
                <p className="empty">No servers yet. Pick a template below to deploy your first one.</p>
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th>Server</th>
                      <th>Status</th>
                      <th>Connect</th>
                      <th>Access</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {servers.map((s) => (
                      <tr key={s.id}>
                        <td>
                          <strong>{s.name}</strong>
                          <div className="muted">{s.templateName}</div>
                        </td>
                        <td>
                          <span className={`dot ${s.status}`} /> {statusLabel[s.status]}
                          {s.lastError && <div className="error small-text">{s.lastError}</div>}
                        </td>
                        <td className="mono">
                          {s.connect.public && <div>{s.connect.public}</div>}
                          {s.connect.instructions && <div className="muted wrap">{s.connect.instructions}</div>}
                          {s.connect.lan && <div className="muted">LAN {s.connect.lan}</div>}
                          <div className="muted">{s.ports.map((p) => `${p.port}/${p.protocol}`).join("  ")}</div>
                          {s.access === "public" && s.pendingRules.length === 0 && (
                            <div className="muted small-text wrap">Reachability untested. Check from a phone on cellular data.</div>
                          )}
                          {s.access === "public" && s.pendingRules.length > 0 && (
                            <div className="warn small-text">Waiting for router rule(s): confirm in the Network panel</div>
                          )}
                        </td>
                        <td>
                          <div className="seg">
                            <button
                              className={s.access === "private" ? "on" : ""}
                              disabled={s.status === "deploying" || s.access === "private"}
                              onClick={() => act(api(`/servers/${s.id}/access`, { method: "PUT", body: { access: "private" } }))}
                            >
                              Private
                            </button>
                            <button
                              className={s.access === "public" ? "on" : ""}
                              disabled={s.status === "deploying" || s.status === "error" || s.access === "public"}
                              onClick={() => act(api(`/servers/${s.id}/access`, { method: "PUT", body: { access: "public" } }))}
                            >
                              Public
                            </button>
                          </div>
                        </td>
                        <td className="actions">
                          {s.status === "error" ? (
                            <button className="ghost small" onClick={() => act(api(`/servers/${s.id}/retry`, { method: "POST" }))}>
                              Retry
                            </button>
                          ) : s.status === "online" ? (
                            <button className="ghost small" onClick={() => act(api(`/servers/${s.id}/stop`, { method: "POST" }))}>
                              Stop
                            </button>
                          ) : (
                            <button className="ghost small" disabled={s.status === "deploying"} onClick={() => act(api(`/servers/${s.id}/start`, { method: "POST" }))}>
                              Start
                            </button>
                          )}
                          <button className="ghost small" disabled={s.status !== "online"} onClick={() => act(api(`/servers/${s.id}/restart`, { method: "POST" }))}>
                            Restart
                          </button>
                          <button className="ghost small" onClick={() => setLogsFor(s)} disabled={s.status === "deploying"}>
                            Logs
                          </button>
                          {s.secrets.length > 0 && (
                            <details className="menu">
                              <summary className="ghost small">Passwords</summary>
                              <div className="menu-items">
                                {s.secrets.map((k) => (
                                  <button key={k} className="link" onClick={() => reveal(s, k)}>
                                    Show {k.toLowerCase().replace(/_/g, " ")}
                                  </button>
                                ))}
                              </div>
                            </details>
                          )}
                          <button className="ghost small danger" onClick={() => remove(s)}>
                            Delete
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>

            <h2>Deploy a new server</h2>
            <div className="templates">
              {templates.map((t) => (
                <button key={t.id} className="template" onClick={() => setDeploying(t)}>
                  <strong>{t.name}</strong>
                  <span className="muted mono">{t.ports.map((p) => `${p.default}/${p.protocol}`).join(" ")}</span>
                </button>
              ))}
            </div>
          </div>

          <NetworkPanel network={network} onChange={refresh} />
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
      {logsFor && <LogViewer id={logsFor.id} name={logsFor.name} onClose={() => setLogsFor(null)} />}
    </div>
  );
}
