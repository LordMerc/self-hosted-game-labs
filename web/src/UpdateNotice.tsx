import { useEffect, useState } from "react";
import { api, type UpdateState } from "./api";
import { useApi } from "./store";

const DISMISS_KEY = "gl-update-dismissed";

function dismissedVersion(): string | null {
  try {
    return localStorage.getItem(DISMISS_KEY);
  } catch {
    return null;
  }
}

/** A line at the top of the Game servers page when a newer release exists. Closing it hides that version only. */
export function UpdateBanner() {
  const state = useApi<UpdateState>("/updates").data ?? null;
  const [dismissed, setDismissed] = useState(dismissedVersion);

  if (!state?.updateAvailable || !state.latest || dismissed === state.latest.version) return null;
  const version = state.latest.version;
  const close = () => {
    setDismissed(version);
    try {
      localStorage.setItem(DISMISS_KEY, version);
    } catch {
      /* private window: it just comes back next visit */
    }
  };
  return (
    <div className="update-banner" role="status">
      <span>
        <strong>Version {version} is available.</strong> You are running {versionLabel(state.current)}.{" "}
        <a href={state.latest.url} target="_blank" rel="noreferrer">
          See what's new
        </a>
      </span>
      <button className="ghost small" onClick={close}>
        Dismiss
      </button>
    </div>
  );
}

const versionLabel = (v: string) => (/^\d/.test(v) ? `v${v}` : v.startsWith("dev-") ? `a development build (${v.slice(4, 11)})` : v);

export function UpdatesSettings() {
  const [state, setState] = useState<UpdateState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const load = () => api<UpdateState>("/updates").then(setState);
  useEffect(() => void load(), []);

  async function toggle(enabled: boolean) {
    setError("");
    setBusy(true);
    try {
      setState(await api<UpdateState>("/updates/settings", { method: "PUT", body: { enabled } }));
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  }

  async function checkNow() {
    setError("");
    setNote("");
    setBusy(true);
    try {
      const r = await api<UpdateState & { ran: boolean }>("/updates/check", { method: "POST" });
      setState(r);
      if (!r.ran) setNote("Checked a moment ago. Try again in a minute.");
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  }

  if (!state) return null;
  return (
    <section className="settings-card">
      <h2>Updates</h2>
      <p>
        You are running <strong>{versionLabel(state.current)}</strong>.{" "}
        {!state.comparable ? (
          <span className="muted">Development builds do not check for updates.</span>
        ) : !state.enabled ? (
          <span className="muted">Update checks are off.</span>
        ) : state.updateAvailable && state.latest ? (
          <>
            <strong>Version {state.latest.version} is available.</strong>{" "}
            <a href={state.latest.url} target="_blank" rel="noreferrer">
              See what's new
            </a>
          </>
        ) : state.latest ? (
          <span className="ok">That is the latest release.</span>
        ) : (
          <span className="muted">Not checked yet.</span>
        )}
      </p>
      {state.comparable && (
        <>
          <label className="check">
            <input type="checkbox" checked={state.enabled} disabled={busy || state.lockedByEnv} onChange={(e) => toggle(e.target.checked)} />
            Check for new versions once a day
          </label>
          <p className="muted small-text">
            The panel asks GitHub for this project's newest release and compares it with the version above. Nothing about your machine is sent, apart from the program name, its version and the address GitHub always sees. It never updates itself.
            {state.lockedByEnv && " This is turned off by the UPDATE_CHECK environment variable."}
          </p>
          {state.enabled && (
            <div className="row">
              <button className="ghost small" disabled={busy} onClick={checkNow}>
                Check now
              </button>
              <span className="muted small-text">{state.checkedAt ? `Last checked ${new Date(state.checkedAt).toLocaleString()}` : ""}</span>
            </div>
          )}
          {state.enabled && state.error && <p className="warn small-text">The last check failed: {state.error}. It will try again within the hour.</p>}
          {note && <p className="muted small-text">{note}</p>}
          {error && <p className="error">{error}</p>}
        </>
      )}
    </section>
  );
}
