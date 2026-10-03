import { useCallback, useEffect, useState } from "react";
import { api, type Backup, type BackupGroup, type Template } from "./api";
import { Backups, size } from "./Backups";
import { GameIcon } from "./GameServers";
import { Nav, type Page } from "./Nav";
import { RedeployDialog } from "./RedeployDialog";

const statusLabel = { deploying: "Deploying", online: "Running", paused: "Paused", offline: "Stopped", updating: "Updating", error: "Error" } as const;

const when = (iso: string) => new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });

export function BackupsPage({ onLogout, onNavigate }: { onLogout: () => void; onNavigate: (p: Page) => void }) {
  const [groups, setGroups] = useState<BackupGroup[] | null>(null);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [settingsFor, setSettingsFor] = useState<BackupGroup | null>(null);
  const [redeploy, setRedeploy] = useState<{ group: BackupGroup; backup: Backup } | null>(null);

  const load = useCallback(() => api<BackupGroup[]>("/backups").then(setGroups).catch((e) => setError(e.message)), []);
  useEffect(() => {
    void load();
    api<Template[]>("/templates").then(setTemplates).catch(() => undefined);
  }, [load]);

  async function run(label: string, call: () => Promise<unknown>) {
    setBusy(label);
    setError("");
    try {
      await call();
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(null);
    await load();
  }

  const restore = (g: BackupGroup, b: Backup) => {
    const running = g.status === "online";
    const msg = `Restore ${b.name}?${running ? " The server stops for a moment and starts again." : ""}\n\nWhat is there now is saved as a new backup first, so you can undo this.`;
    if (confirm(msg)) void run(`restore ${b.name}`, () => api(`/servers/${g.serverId}/backups/${b.name}/restore`, { method: "POST" }));
  };
  const remove = (g: BackupGroup, b: Backup) => confirm(`Delete ${b.name}? This cannot be undone.`) && void run(`delete ${b.name}`, () => api(`/backups/${g.slug}/${b.name}`, { method: "DELETE" }));

  const live = (groups ?? []).filter((g) => !g.deleted);
  const gone = (groups ?? []).filter((g) => g.deleted);
  const total = (groups ?? []).reduce((n, g) => ({ count: n.count + g.backups.length, bytes: n.bytes + g.totalBytes }), { count: 0, bytes: 0 });

  const card = (g: BackupGroup) => {
    const latest = g.backups[0];
    const locked = g.status === "deploying" || g.status === "updating";
    return (
      <section key={g.slug} className={`backup-group${g.deleted ? " deleted" : ""}`}>
        <div className="backup-group-head">
          <div className="server-cell">
            <GameIcon id={g.templateId ?? g.slug} name={g.templateName ?? g.name} />
            <div>
              <strong>{g.name}</strong>
              <div className="muted">
                {g.templateName && g.templateName !== g.name ? `${g.templateName} · ` : g.templateName ? "" : "Game unknown · "}{g.backups.length === 0 ? "no backups yet" : `${g.backups.length} ${g.backups.length === 1 ? "backup" : "backups"}, ${size(g.totalBytes)}`}
                {latest && <> · latest {when(latest.createdAt)}</>}
              </div>
            </div>
          </div>
          <div className="row">
            {g.deleted ? (
              <span className="badge bad">Server deleted</span>
            ) : (
              <>
                <span className={`status ${g.status}`}>
                  <span className={`dot ${g.status}`} /> {statusLabel[g.status!]}
                </span>
                <button className="ghost small" disabled={busy !== null || locked} onClick={() => setSettingsFor(g)}>
                  Backup settings
                </button>
                <button className="primary small" disabled={busy !== null || locked} onClick={() => void run(`backup ${g.slug}`, () => api(`/servers/${g.serverId}/backups`, { method: "POST" }))}>
                  {busy === `backup ${g.slug}` ? "Backing up…" : "Back up now"}
                </button>
              </>
            )}
          </div>
        </div>
        {g.deleted && <p className="muted note">This server was deleted, but its backups are kept. Pick one to set the server up again with its world, or delete the ones you no longer need.</p>}
        {g.backups.length === 0 ? (
          <p className="muted small-text">The first automatic backup is made within the hour, or press Back up now.</p>
        ) : (
          <ul className="backup-list">
            {g.backups.map((b) => (
              <li key={b.name}>
                <div>
                  <div className="mono">{b.name}</div>
                  <div className="muted small-text">
                    {when(b.createdAt)} · {size(b.sizeBytes)}
                  </div>
                </div>
                <div className="row">
                  {g.deleted ? (
                    <button className="primary small" disabled={busy !== null} onClick={() => setRedeploy({ group: g, backup: b })}>
                      Set up again
                    </button>
                  ) : (
                    <button className="ghost small" disabled={busy !== null || locked} onClick={() => restore(g, b)}>
                      {busy === `restore ${b.name}` ? "Restoring…" : "Restore"}
                    </button>
                  )}
                  <button className="ghost small" disabled={busy !== null} onClick={() => remove(g, b)}>
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    );
  };

  return (
    <div className="shell">
      <Nav page="backups" onNavigate={onNavigate} onLogout={onLogout} />
      <main className="content">
        <header className="page-head">
          <div>
            <h1>Backups</h1>
            {groups && <p className="muted">{total.count === 0 ? "Nothing backed up yet." : `${total.count} ${total.count === 1 ? "backup" : "backups"} across ${groups.filter((g) => g.backups.length > 0).length} ${groups.filter((g) => g.backups.length > 0).length === 1 ? "server" : "servers"}, ${size(total.bytes)} in all.`}</p>}
          </div>
        </header>
        {error && <p className="error banner">{error}</p>}
        {groups === null ? (
          <p className="muted">Loading…</p>
        ) : groups.length === 0 ? (
          <p className="empty">No servers yet. Backups of your servers show up here, and stay here if you delete a server.</p>
        ) : (
          <div className="backup-groups">
            {live.map(card)}
            {gone.length > 0 && <h2 className="backup-section">Deleted servers</h2>}
            {gone.map(card)}
          </div>
        )}
      </main>

      {settingsFor && <Backups id={settingsFor.serverId!} name={settingsFor.name} running={settingsFor.status === "online"} onClose={() => setSettingsFor(null)} onChange={() => void load()} />}
      {redeploy && <RedeployDialog group={redeploy.group} backup={redeploy.backup} templates={templates} onClose={() => setRedeploy(null)} onDone={() => onNavigate("servers")} />}
    </div>
  );
}
