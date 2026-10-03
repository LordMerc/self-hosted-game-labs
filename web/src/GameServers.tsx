import { useEffect, useState } from "react";
import { api, type Server, type Template } from "./api";

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

  useEffect(() => {
    api<Server[]>("/servers").then(setServers);
    api<Template[]>("/templates").then(setTemplates);
  }, []);

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

        <section className="card">
          {servers.length === 0 ? (
            <p className="empty">No servers yet. Pick a template below to deploy your first one.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Server</th>
                  <th>Status</th>
                  <th>Ports</th>
                  <th>Access</th>
                </tr>
              </thead>
              <tbody>
                {servers.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <strong>{s.name}</strong>
                      <div className="muted">{s.templateId}</div>
                    </td>
                    <td>
                      <span className={`dot ${s.status}`} /> {statusLabel[s.status]}
                    </td>
                    <td className="mono">{s.ports.map((p) => `${p.port}/${p.protocol}`).join("  ")}</td>
                    <td>
                      <span className="pill">{s.access === "public" ? "Public" : "Private"}</span>
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
            <button key={t.id} className="template" disabled title="Deploy lands in the next Milestone 1 step">
              <strong>{t.name}</strong>
              <span className="muted mono">{t.ports.map((p) => `${p.default}/${p.protocol}`).join(" ")}</span>
            </button>
          ))}
        </div>
      </main>
    </div>
  );
}
