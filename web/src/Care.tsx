import { useEffect, useState, type FormEvent } from "react";
import { api, type ServerDetail as Detail } from "./api";
import { Hint } from "./Hint";

const WARN_LABEL: Record<number, string> = { 0: "No warning", 1: "1 minute before", 5: "5 minutes before", 10: "10 minutes before", 15: "15 minutes before" };

/** Daily restart, and updates: check for a newer version, switch to it, or let the panel do it each day. */
export function Upkeep({ detail, disabled, onChanged }: { detail: Detail; disabled: boolean; onChanged: () => Promise<void> }) {
  const id = detail.server.id;
  const care = detail.care;
  const [restartOn, setRestartOn] = useState(care.settings.restart.enabled);
  const [restartAt, setRestartAt] = useState(care.settings.restart.time);
  const [warn, setWarn] = useState(care.settings.restart.warnMinutes);
  const [autoOn, setAutoOn] = useState(care.settings.update.auto);
  const [autoAt, setAutoAt] = useState(care.settings.update.time);
  const [busy, setBusy] = useState<"" | "save" | "check" | "apply">("");
  const [error, setError] = useState("");
  const [note, setNote] = useState("");

  const dirty =
    restartOn !== care.settings.restart.enabled ||
    restartAt !== care.settings.restart.time ||
    warn !== care.settings.restart.warnMinutes ||
    autoOn !== care.settings.update.auto ||
    autoAt !== care.settings.update.time;

  async function run(what: "save" | "check" | "apply", fn: () => Promise<string>) {
    setBusy(what);
    setError("");
    setNote("");
    try {
      setNote(await fn());
      await onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy("");
  }

  const save = (ev: FormEvent) => {
    ev.preventDefault();
    void run("save", async () => {
      await api(`/servers/${id}/care`, {
        method: "PUT",
        body: { restart: { enabled: restartOn, time: restartAt, warnMinutes: warn }, update: { auto: autoOn, time: autoAt } },
      });
      return "Saved.";
    });
  };

  const check = () =>
    void run("check", async () => {
      await api(`/servers/${id}/update/check`, { method: "POST" }); // the result is shown below from the saved check
      return "";
    });

  const apply = () => {
    if (!confirm(`Update ${detail.server.name}? A backup is made first, then the server restarts on the new version. Your world is kept.`)) return;
    void run("apply", async () => {
      await api(`/servers/${id}/update/apply`, { method: "POST" });
      return "Updating. A backup was made and the server is restarting on the new version.";
    });
  };

  const upd = care.update;

  return (
    <form className="settings-card" onSubmit={save}>
      <h2>
        Restarts and updates
        <Hint label="About restarts and updates">Games slowly leak memory and patch often. A daily restart keeps them fresh, and updates move the server to a newer version of the game&apos;s Docker image.</Hint>
      </h2>

      <h3>Daily restart</h3>
      <div className="row wrap-row">
        <label className="check">
          <input type="checkbox" checked={restartOn} onChange={(e) => setRestartOn(e.target.checked)} disabled={disabled} /> Restart every day at
        </label>
        <input type="time" value={restartAt} onChange={(e) => setRestartAt(e.target.value)} disabled={disabled || !restartOn} aria-label="Restart time" required />
      </div>
      {care.canWarn ? (
        <label className="field">
          <span>Warn the players in the game</span>
          <select value={warn} onChange={(e) => setWarn(Number(e.target.value))} disabled={disabled || !restartOn} aria-label="Warning before restart">
            {Object.entries(WARN_LABEL).map(([m, label]) => (
              <option key={m} value={m}>
                {label}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <p className="muted small-text">This game has no way to show a message to players, so they are disconnected without a warning.</p>
      )}
      <p className="muted small-text">Times use the panel&apos;s time zone ({care.timezone}). A stopped server is left stopped.</p>

      <h3>Updates</h3>
      <p>
        Running <span className="mono">{care.image.name}</span>
        {care.image.pinned && !care.image.moved && <span className="muted"> (the version this game was tested with)</span>}
        {care.image.moved && <span className="muted"> (updated from the panel)</span>}
      </p>
      <div className="row wrap-row">
        <button type="button" className="ghost" onClick={check} disabled={disabled || busy !== "" || detail.server.status === "error"}>
          {busy === "check" ? "Checking…" : "Check for update"}
        </button>
        {upd?.available && (
          <button type="button" className="primary" onClick={apply} disabled={disabled || busy !== ""}>
            {busy === "apply" ? "Updating…" : upd.latest ? `Update to ${upd.latest}` : "Update now"}
          </button>
        )}
      </div>
      {upd && (
        <p className={upd.available ? "update-note" : "muted small-text"}>
          {upd.note} <span className="muted small-text">Checked {new Date(upd.checkedAt).toLocaleString()}.</span>
        </p>
      )}
      <div className="row wrap-row">
        <label className="check">
          <input type="checkbox" checked={autoOn} onChange={(e) => setAutoOn(e.target.checked)} disabled={disabled} /> Update automatically every day at
        </label>
        <input type="time" value={autoAt} onChange={(e) => setAutoAt(e.target.value)} disabled={disabled || !autoOn} aria-label="Update time" required />
      </div>
      <p className="muted small-text">Automatic updates only touch a running server, and always make a backup first.</p>

      {error && <p className="error">{error}</p>}
      {note && <p className="muted">{note}</p>}
      <div className="row end">
        <button className="primary" disabled={disabled || busy !== "" || !dirty}>
          {busy === "save" ? "Saving…" : "Save schedule"}
        </button>
      </div>
    </form>
  );
}

/** Move the server to another game port (the others move with it). */
export function PortsCard({ detail, disabled, onChanged }: { detail: Detail; disabled: boolean; onChanged: () => Promise<void> }) {
  const ports = detail.server.ports;
  const [value, setValue] = useState(String(ports[0]?.port ?? ""));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const dirty = value !== String(ports[0]?.port);
  // Follow the real port once the change has gone through, without losing the message below.
  useEffect(() => setValue(String(ports[0]?.port ?? "")), [ports[0]?.port]);

  async function save(ev: FormEvent) {
    ev.preventDefault();
    const port = Number(value);
    if (!confirm(`Move ${detail.server.name} to port ${port}? The server restarts and players need the new port. Your world is kept.`)) return;
    setBusy(true);
    setError("");
    setNote("");
    try {
      const r = await api<{ restarting: boolean }>(`/servers/${detail.server.id}/ports`, { method: "PUT", body: { port } });
      setNote(r.restarting ? "Done. The server is restarting on the new port." : "Nothing changed.");
      await onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  }

  return (
    <form className="settings-card" onSubmit={save}>
      <h2>Ports</h2>
      <div className="chips">
        {ports.map((p) => (
          <span key={`${p.port}${p.protocol}`} className="chip mono" title={p.name}>
            {p.name} {p.port} <span className="proto">{p.protocol.toUpperCase()}</span>
          </span>
        ))}
      </div>
      {detail.care.portsEditable ? (
        <>
          <label className="field">
            <span>
              Game port
              <Hint label="About changing the port">The other ports of this game move by the same amount. On a public server the router rules are moved too.</Hint>
            </span>
            <input type="number" min={1024} max={65535} value={value} onChange={(e) => setValue(e.target.value)} disabled={disabled || busy} aria-label="Game port" />
          </label>
          {error && <p className="error">{error}</p>}
          {note && <p className="muted">{note}</p>}
          <div className="row end">
            <button className="primary" disabled={disabled || busy || !dirty || !value}>
              {busy ? "Changing…" : "Change port"}
            </button>
          </div>
        </>
      ) : (
        <p className="muted small-text">This custom image decides its own ports, so they cannot be changed here. Set it up again with the ports you want.</p>
      )}
    </form>
  );
}
