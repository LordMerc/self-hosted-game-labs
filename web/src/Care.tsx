import { useEffect, useState } from "react";
import { api, type ServerDetail as Detail } from "./api";
import { Hint } from "./Hint";

const WARN_LABEL: Record<number, string> = { 0: "No warning", 1: "1 minute before", 5: "5 minutes before", 10: "10 minutes before", 15: "15 minutes before" };

/**
 * Daily restart and updates. The schedule is saved together with the rest of the settings (see `save`), while checking for an
 * update and switching to it are their own actions.
 */
export function useUpkeep(detail: Detail, onChanged: () => Promise<void>) {
  const id = detail.server.id;
  const care = detail.care;
  const [restartOn, setRestartOn] = useState(care.settings.restart.enabled);
  const [restartAt, setRestartAt] = useState(care.settings.restart.time);
  const [warn, setWarn] = useState(care.settings.restart.warnMinutes);
  const [autoOn, setAutoOn] = useState(care.settings.update.auto);
  const [autoAt, setAutoAt] = useState(care.settings.update.time);
  const [busy, setBusy] = useState<"" | "check" | "apply">("");
  const [error, setError] = useState("");
  const [note, setNote] = useState("");

  const dirty =
    restartOn !== care.settings.restart.enabled ||
    restartAt !== care.settings.restart.time ||
    warn !== care.settings.restart.warnMinutes ||
    autoOn !== care.settings.update.auto ||
    autoAt !== care.settings.update.time;

  async function run(what: "check" | "apply", fn: () => Promise<void>) {
    setBusy(what);
    setError("");
    setNote("");
    try {
      await fn();
      await onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy("");
  }

  return {
    restartOn,
    setRestartOn,
    restartAt,
    setRestartAt,
    warn,
    setWarn,
    autoOn,
    setAutoOn,
    autoAt,
    setAutoAt,
    busy,
    error,
    note,
    dirty,
    /** Saves the schedule. Throws with the server's message when it is refused. */
    save: () =>
      api(`/servers/${id}/care`, {
        method: "PUT",
        body: { restart: { enabled: restartOn, time: restartAt, warnMinutes: warn }, update: { auto: autoOn, time: autoAt } },
      }),
    check: () =>
      run("check", async () => {
        await api(`/servers/${id}/update/check`, { method: "POST" }); // the result is shown from the saved check
      }),
    apply: () => {
      if (!confirm(`Update ${detail.server.name}? A backup is made first, then the server restarts on the new version. Your world is kept.`)) return;
      void run("apply", async () => {
        await api(`/servers/${id}/update/apply`, { method: "POST" });
        setNote("Updating. A backup was made and the server is restarting on the new version.");
      });
    },
  };
}

export type Upkeep = ReturnType<typeof useUpkeep>;

/** The Schedule group of the settings form: daily restart, update check, automatic updates. */
export function ScheduleFields({ detail, up, disabled }: { detail: Detail; up: Upkeep; disabled: boolean }) {
  const care = detail.care;
  const upd = care.update;
  return (
    <div className="schedule">
      <div className="row wrap-row">
        <label className="check">
          <input type="checkbox" checked={up.restartOn} onChange={(e) => up.setRestartOn(e.target.checked)} disabled={disabled} /> Restart every day at
        </label>
        <input type="time" value={up.restartAt} onChange={(e) => up.setRestartAt(e.target.value)} disabled={disabled || !up.restartOn} aria-label="Restart time" required />
        {care.canWarn ? (
          <label className="inline-field">
            <span className="muted">Warn the players</span>
            <select value={up.warn} onChange={(e) => up.setWarn(Number(e.target.value))} disabled={disabled || !up.restartOn} aria-label="Warning before restart">
              {Object.entries(WARN_LABEL).map(([m, label]) => (
                <option key={m} value={m}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <Hint label="About restarts and updates">Games slowly leak memory and patch often. A daily restart keeps them fresh, and updates move the server to a newer version of the game&apos;s Docker image.</Hint>
      </div>
      {!care.canWarn && <p className="muted small-text">This game has no way to show a message to players, so they are disconnected without a warning.</p>}
      <p className="muted small-text">Times use the panel&apos;s time zone ({care.timezone}). A stopped server is left stopped.</p>

      <div className="row wrap-row">
        <button type="button" className="ghost" onClick={up.check} disabled={disabled || up.busy !== "" || detail.server.status === "error"}>
          {up.busy === "check" ? "Checking…" : "Check for update"}
        </button>
        {upd?.available && (
          <button type="button" className="primary" onClick={up.apply} disabled={disabled || up.busy !== ""}>
            {up.busy === "apply" ? "Updating…" : upd.latest ? `Update to ${upd.latest}` : "Update now"}
          </button>
        )}
        <label className="check auto-update">
          <input type="checkbox" checked={up.autoOn} onChange={(e) => up.setAutoOn(e.target.checked)} disabled={disabled} /> Update automatically every day at
        </label>
        <input type="time" value={up.autoAt} onChange={(e) => up.setAutoAt(e.target.value)} disabled={disabled || !up.autoOn} aria-label="Update time" required />
      </div>
      {upd && (
        <p className={upd.available ? "update-note" : "muted small-text"}>
          {upd.note} <span className="muted small-text">Checked {new Date(upd.checkedAt).toLocaleString()}.</span>
        </p>
      )}
      <p className="muted small-text">Automatic updates only touch a running server, and always make a backup first.</p>
      {up.error && <p className="error">{up.error}</p>}
      {up.note && <p className="muted">{up.note}</p>}
    </div>
  );
}

/** Move the server to another game port (the others move with it). It is its own action, with its own confirmation. */
export function PortField({ detail, disabled, onChanged }: { detail: Detail; disabled: boolean; onChanged: () => Promise<void> }) {
  const ports = detail.server.ports;
  const [value, setValue] = useState(String(ports[0]?.port ?? ""));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const dirty = value !== String(ports[0]?.port);
  // Follow the real port once the change has gone through, without losing the message below.
  useEffect(() => setValue(String(ports[0]?.port ?? "")), [ports[0]?.port]);

  async function change() {
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

  if (!detail.care.portsEditable) {
    return <p className="muted small-text">This custom image decides its own ports, so they cannot be changed here. Set it up again with the ports you want.</p>;
  }
  return (
    <div className="field">
      <span>
        Game port
        <Hint label="About changing the port">The other ports of this game move by the same amount. On a public server the router rules are moved too.</Hint>
      </span>
      <div className="row">
        <input type="number" min={1024} max={65535} value={value} onChange={(e) => setValue(e.target.value)} disabled={disabled || busy} aria-label="Game port" />
        <button type="button" className="ghost" onClick={() => void change()} disabled={disabled || busy || !dirty || !value}>
          {busy ? "Changing…" : "Change port"}
        </button>
      </div>
      {error && <span className="error small-text wrap">{error}</span>}
      {note && <span className="muted small-text wrap">{note}</span>}
    </div>
  );
}
