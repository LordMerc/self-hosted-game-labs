import { useCallback, useEffect, useState } from "react";
import { api, type Backup } from "./api";

function size(n: number) {
  if (n < 1000) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let i = -1;
  do (n /= 1000), i++;
  while (n >= 1000 && i < units.length - 1);
  return `${n >= 100 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}

export function Backups({ id, name, running, onClose, onChange }: { id: string; name: string; running: boolean; onClose: () => void; onChange: () => void }) {
  const [list, setList] = useState<Backup[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(() => api<Backup[]>(`/servers/${id}/backups`).then(setList).catch((e) => setError(e.message)), [id]);
  useEffect(() => void load(), [load]);

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
    onChange();
  }

  const restore = (b: Backup) => {
    const msg = `Restore ${b.name}?${running ? " The server stops for a moment and starts again." : ""}\n\nWhat is there now is saved as a new backup first, so you can undo this.`;
    if (confirm(msg)) void run(`restore ${b.name}`, () => api(`/servers/${id}/backups/${b.name}/restore`, { method: "POST" }));
  };

  return (
    <div className="backdrop" onClick={onClose}>
      <div className="card dialog backups" onClick={(e) => e.stopPropagation()}>
        <div className="row between">
          <h2>{name} backups</h2>
          <button className="ghost" onClick={onClose}>
            Close
          </button>
        </div>
        <p className="muted note">
          A backup is a compressed copy of this server&apos;s world and settings. The server keeps running while it is made; for a perfectly clean copy, stop it first. Backups are kept for at least 7 days, and deleting the server does not delete them: to get one back later, create a new server with the same name and open its Backups.
        </p>
        <div>
          <button className="primary" disabled={busy !== null} onClick={() => run("backup", () => api(`/servers/${id}/backups`, { method: "POST" }))}>
            {busy === "backup" ? "Backing up…" : "Back up now"}
          </button>
        </div>
        {error && <p className="error">{error}</p>}
        {list === null ? (
          <p className="muted">Loading…</p>
        ) : list.length === 0 ? (
          <p className="muted">No backups yet.</p>
        ) : (
          <ul className="backup-list">
            {list.map((b) => (
              <li key={b.name}>
                <div>
                  <div className="mono">{b.name}</div>
                  <div className="muted small-text">
                    {new Date(b.createdAt).toLocaleString()} · {size(b.sizeBytes)}
                  </div>
                </div>
                <div className="row">
                  <button className="ghost small" disabled={busy !== null} onClick={() => restore(b)}>
                    {busy === `restore ${b.name}` ? "Restoring…" : "Restore"}
                  </button>
                  <button
                    className="ghost small"
                    disabled={busy !== null}
                    onClick={() => confirm(`Delete ${b.name}?`) && void run("delete", () => api(`/servers/${id}/backups/${b.name}`, { method: "DELETE" }))}
                  >
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
