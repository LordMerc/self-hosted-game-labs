import { useCallback, useEffect, useState } from "react";
import { api, type Backup, type BackupSettings } from "./api";
import { Hint } from "./Hint";

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
  const [saved, setSaved] = useState<BackupSettings | null>(null);
  const [keep, setKeep] = useState("");
  const [days, setDays] = useState("");

  const load = useCallback(() => api<Backup[]>(`/servers/${id}/backups`).then(setList).catch((e) => setError(e.message)), [id]);
  useEffect(() => void load(), [load]);
  useEffect(() => {
    api<BackupSettings>(`/servers/${id}/backups/settings`)
      .then((s) => (setSaved(s), setKeep(String(s.keep)), setDays(String(s.minDays))))
      .catch((e) => setError(e.message));
  }, [id]);

  const dirty = saved !== null && (keep !== String(saved.keep) || days !== String(saved.minDays));
  async function saveSettings() {
    setError("");
    try {
      const s = await api<BackupSettings>(`/servers/${id}/backups/settings`, { method: "PUT", body: { keep: Number(keep), minDays: Number(days) } });
      setSaved(s);
      setKeep(String(s.keep));
      setDays(String(s.minDays));
    } catch (e) {
      setError((e as Error).message);
    }
  }

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
          A backup is a compressed copy of this server&apos;s world and settings. The server keeps running while it is made; for a perfectly clean copy, stop it first. Deleting the server does not delete its backups: to get one back later, create a new server with the same name and open its Backups.
        </p>
        <div className="backup-settings">
          <label>
            Keep up to
            <Hint label="About the backup limit">
              The most backups to hold on to. When a new backup would take you over this number, the oldest one is deleted. Example: 5 means the sixth backup replaces the oldest.
            </Hint>
            <input type="number" min={1} max={100} value={keep} onChange={(e) => setKeep(e.target.value)} />
            backups
          </label>
          <label>
            but never delete one younger than
            <Hint label="About the minimum age">
              A safety net: a backup younger than this many days is never deleted, even if you are over the limit. Example: 7 means last week&apos;s backups are always safe. Use 0 to let the count alone decide.
            </Hint>
            <input type="number" min={0} max={365} value={days} onChange={(e) => setDays(e.target.value)} />
            days
          </label>
          <button className="ghost small" disabled={!dirty} onClick={saveSettings}>
            Save
          </button>
          <p className="muted note">When a new backup makes the count go over, the oldest one is deleted. Set days to 0 to let the count alone decide.</p>
        </div>
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
