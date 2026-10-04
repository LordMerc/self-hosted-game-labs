import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, type DnsStatus, type NotificationStatus, type RelayStatus, type NotifyKind, type TokenCheck } from "./api";
import { Nav, type Page } from "./Nav";
import { takeRelayFocus } from "./relayFocus";
import { UpdatesSettings } from "./UpdateNotice";

export function Settings({ onLogout, onNavigate }: { onLogout: () => void; onNavigate: (p: Page) => void }) {
  const [status, setStatus] = useState<DnsStatus | null>(null);
  const [editing, setEditing] = useState(false);
  const load = () => api<DnsStatus>("/settings/dns").then(setStatus);
  useEffect(() => void load(), []);

  async function remove() {
    if (!confirm("Remove the Cloudflare setup? Existing DNS records stay in Cloudflare, but the panel stops managing them.")) return;
    await api("/settings/dns", { method: "DELETE" });
    await load();
  }

  return (
    <div className="shell">
      <Nav page="settings" onNavigate={onNavigate} onLogout={onLogout} />
      <main className="content">
        <header className="page-head">
          <h1>Settings</h1>
        </header>

        <section className="settings-card">
          <h2>Domain &amp; DNS</h2>
          <p className="muted">
            Give each public server a friendly name like <span className="mono">palworld.example.com</span> instead of an IP address. The panel creates the names and keeps them pointed at your home IP using
            Cloudflare. You need a domain on Cloudflare (free plan is fine). The names are DNS only, not a proxy, so anyone who looks one up can see your home IP.
          </p>

          {status?.configured && !editing ? (
            <div className="dns-status">
              <p>
                <span className="dot online" /> Connected to <strong>{status.zone}</strong> · players join at <span className="mono">&lt;server&gt;.{status.zone}</span> · home address{" "}
                <span className="mono">{status.host}</span>
              </p>
              {status.source === "env" ? (
                <p className="muted small-text">Set by environment variables (CF_API_TOKEN, CF_ZONE, PUBLIC_HOST). Remove them to manage it here.</p>
              ) : (
                <div className="row">
                  <button className="ghost small" onClick={() => setEditing(true)}>
                    Change
                  </button>
                  <button className="ghost small danger" onClick={remove}>
                    Remove
                  </button>
                </div>
              )}
            </div>
          ) : (
            status && <DnsForm status={status} onSaved={() => (setEditing(false), load())} onCancel={status.configured ? () => setEditing(false) : undefined} />
          )}
        </section>

        <HideMyIp />

        <Notifications />

        <UpdatesSettings />
      </main>
    </div>
  );
}

function DnsForm({ status, onSaved, onCancel }: { status: DnsStatus; onSaved: () => void; onCancel?: () => void }) {
  const [token, setToken] = useState("");
  const [check, setCheck] = useState<TokenCheck | null>(null);
  const [zone, setZone] = useState(status.zone ?? "");
  const [host, setHost] = useState(status.host ?? "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function verify() {
    setError("");
    setBusy(true);
    try {
      const r = await api<TokenCheck>("/settings/dns/check", { method: "POST", body: { token } });
      setCheck(r);
      if (r.valid && r.zones.length > 0) pickZone(r.zones[0]);
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  }

  function pickZone(z: string) {
    setZone(z);
    setHost((h) => (h && h.endsWith(`.${z}`) ? h : `play.${z}`));
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      await api("/settings/dns", { method: "PUT", body: { token: token || undefined, zone, host } });
      onSaved();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  const ready = check?.valid === true || status.tokenSet;
  return (
    <form onSubmit={save} className="dns-form">
      <h3>1. Create an API token in Cloudflare (once, about two minutes)</h3>
      <ol className="steps">
        <li>
          Open{" "}
          <a href="https://dash.cloudflare.com/profile/api-tokens" target="_blank" rel="noreferrer">
            Cloudflare → My Profile → API Tokens
          </a>{" "}
          and click <strong>Create Token</strong>.
        </li>
        <li>
          Choose <strong>Create Custom Token</strong>. Add two permissions: <strong>Zone · Zone · Read</strong> and <strong>Zone · DNS · Edit</strong>.
        </li>
        <li>
          Under Zone Resources pick <strong>Include · Specific zone</strong> and select your domain.
        </li>
        <li>Create the token and copy it. Cloudflare only shows it once.</li>
      </ol>

      <h3>2. Paste it here</h3>
      <div className="row">
        <input type="password" autoComplete="off" placeholder={status.tokenSet ? "Token saved (paste a new one to replace it)" : "Cloudflare API token"} value={token} onChange={(e) => (setToken(e.target.value), setCheck(null))} />
        <button type="button" className="ghost" disabled={!token || busy} onClick={verify}>
          Check token
        </button>
      </div>
      {check && !check.valid && <p className="error">That token didn't work: {check.error}</p>}
      {check?.valid && check.zones.length === 0 && (
        <p className="warn">The token is valid but can't list your domains{check.zonesError ? ` (${check.zonesError})` : ""}. Add the Zone · Zone · Read permission, or type your domain below.</p>
      )}
      {check?.valid && check.zones.length > 0 && <p className="ok">Token works. Found {check.zones.length} domain{check.zones.length === 1 ? "" : "s"}.</p>}

      {ready && (
        <>
          <h3>3. Pick your domain and the home address name</h3>
          <label>
            Domain
            {check?.valid && check.zones.length > 0 ? (
              <select value={zone} onChange={(e) => pickZone(e.target.value)}>
                {check.zones.map((z) => (
                  <option key={z}>{z}</option>
                ))}
              </select>
            ) : (
              <input value={zone} placeholder="example.com" onChange={(e) => pickZone(e.target.value.trim())} />
            )}
          </label>
          <label>
            Home address name
            <input value={host} placeholder={`play.${zone || "example.com"}`} onChange={(e) => setHost(e.target.value)} />
            <span className="muted small-text">This name always points at your home IP. Each server gets its own name that points here.</span>
          </label>
        </>
      )}

      {error && <p className="error">{error}</p>}
      <div className="row">
        <button className="primary" disabled={!ready || !zone || !host || busy}>
          {busy ? "Saving…" : "Save"}
        </button>
        {onCancel && (
          <button type="button" className="ghost" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

const EVENT_LABELS: { kind: NotifyKind; label: string }[] = [
  { kind: "online", label: "A server comes online" },
  { kind: "down", label: "A server goes down or crashes" },
  { kind: "playerJoin", label: "A player joins" },
  { kind: "playerLeave", label: "A player leaves" },
  { kind: "backupFailed", label: "A backup fails" },
];

function Notifications() {
  const [status, setStatus] = useState<NotificationStatus | null>(null);
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<Record<NotifyKind, boolean> | null>(null);
  const [editing, setEditing] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () =>
    api<NotificationStatus>("/settings/notifications").then((s) => {
      setStatus(s);
      setEvents(s.events);
    });
  useEffect(() => void load(), []);

  async function run(work: () => Promise<string>) {
    setMessage(null);
    setBusy(true);
    try {
      setMessage({ ok: true, text: await work() });
    } catch (e) {
      setMessage({ ok: false, text: (e as Error).message });
    }
    setBusy(false);
  }

  const test = () =>
    run(async () => {
      await api("/settings/notifications/test", { method: "POST", body: { url: url || undefined } });
      return "Sent. Check your channel for the test message.";
    });

  async function save(e: FormEvent) {
    e.preventDefault();
    await run(async () => {
      await api("/settings/notifications", { method: "PUT", body: { url: url || undefined, events } });
      setUrl("");
      setEditing(false);
      await load();
      return "Saved.";
    });
  }

  async function remove() {
    if (!confirm("Remove the webhook? The panel stops sending notifications.")) return;
    await api("/settings/notifications", { method: "DELETE" });
    setUrl("");
    setEditing(false);
    setMessage(null);
    await load();
  }

  const asking = !status?.configured || editing;
  return (
    <section className="settings-card">
      <h2>Notifications</h2>
      <p className="muted">
        Get a message in Discord when something happens to your servers, so you find out before your friends do. Any other service that accepts a webhook (Slack, Mattermost, n8n, Home Assistant) works too.
      </p>

      {status && !asking && (
        <div className="dns-status">
          <p>
            <span className="dot online" /> Sending to {status.kind === "discord" ? "Discord" : "a webhook"} at <span className="mono">{status.host}</span>
          </p>
          {status.lastError && <p className="error">The last message did not go through: {status.lastError}</p>}
          <div className="row">
            <button className="ghost small" disabled={busy} onClick={test}>
              Send test message
            </button>
            <button className="ghost small" onClick={() => setEditing(true)}>
              Change
            </button>
            <button className="ghost small danger" onClick={remove}>
              Remove
            </button>
          </div>
        </div>
      )}

      {status && asking && (
        <form onSubmit={save} className="dns-form notify-form">
          <h3>1. Make a webhook in Discord (about a minute)</h3>
          <ol className="steps">
            <li>
              Open the Discord server and channel you want the messages in, then <strong>Edit Channel → Integrations → Webhooks → New Webhook</strong>.
            </li>
            <li>
              Click <strong>Copy Webhook URL</strong>.
            </li>
          </ol>
          <h3>2. Paste it here</h3>
          <div className="row">
            <input type="password" autoComplete="off" placeholder={status.configured ? "Webhook saved (paste a new one to replace it)" : "https://discord.com/api/webhooks/…"} value={url} onChange={(e) => setUrl(e.target.value)} />
            <button type="button" className="ghost" disabled={(!url && !status.configured) || busy} onClick={test}>
              Send test message
            </button>
          </div>
          <p className="muted small-text">The address works like a password for that channel, so the panel stores it encrypted and never shows it again.</p>
          {events && <EventToggles events={events} onChange={setEvents} />}
          <div className="row">
            <button className="primary" disabled={(!url && !status.configured) || busy}>
              {busy ? "Working…" : "Save"}
            </button>
            {status.configured && (
              <button type="button" className="ghost" onClick={() => (setEditing(false), setUrl(""), setEvents(status.events))}>
                Cancel
              </button>
            )}
          </div>
        </form>
      )}

      {status && !asking && events && (
        <>
          <h3>Tell me when</h3>
          <EventToggles
            events={events}
            onChange={(next) => {
              setEvents(next);
              void api("/settings/notifications", { method: "PUT", body: { events: next } }).catch((e: Error) => setMessage({ ok: false, text: e.message }));
            }}
          />
        </>
      )}
      {message && <p className={message.ok ? "ok" : "error"}>{message.text}</p>}
    </section>
  );
}

function EventToggles({ events, onChange }: { events: Record<NotifyKind, boolean>; onChange: (e: Record<NotifyKind, boolean>) => void }) {
  return (
    <div className="dns-form">
      {EVENT_LABELS.map(({ kind, label }) => (
        <label key={kind} className="check">
          <input type="checkbox" checked={events[kind]} onChange={(e) => onChange({ ...events, [kind]: e.target.checked })} />
          {label}
        </label>
      ))}
    </div>
  );
}

/** Settings for the playit.gg relay behind the per-server "Hide my IP" option. The secret key is sent once and never shown again. */
function HideMyIp() {
  const [status, setStatus] = useState<RelayStatus | null>(null);
  const [editing, setEditing] = useState(false);
  const [secret, setSecret] = useState("");
  const [mode, setMode] = useState<"existing" | "managed">("existing");
  const [localHost, setLocalHost] = useState("");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState("");
  const cardRef = useRef<HTMLElement>(null);
  const focused = useRef(false);
  // Arriving from "Open Settings" or "Finish setup": scroll here once the card exists.
  useEffect(() => {
    if (status && !focused.current && takeRelayFocus()) {
      focused.current = true;
      cardRef.current?.scrollIntoView({ block: "start" });
    }
  }, [status]);

  const load = () =>
    api<RelayStatus>("/settings/relay")
      .then((s) => {
        setStatus(s);
        setLoadError("");
        setMode(s.mode);
        setLocalHost(s.localHost ?? "");
      })
      .catch((e: Error) => (setStatus(null), setLoadError(e.message)));
  useEffect(() => void load(), []);

  async function save(e: FormEvent) {
    e.preventDefault();
    setMessage(null);
    setBusy(true);
    try {
      await api("/settings/relay", { method: "PUT", body: { secret: secret || undefined, mode, localHost: localHost || undefined } });
      setSecret("");
      setEditing(false);
      await load();
      setMessage({ ok: true, text: "Saved. The key works." });
    } catch (err) {
      setMessage({ ok: false, text: (err as Error).message });
    }
    setBusy(false);
  }

  /** Saves the machine's home network address as the agent's address in one click, keeping the saved key. */
  async function useLan(ip: string) {
    setMessage(null);
    setBusy(true);
    try {
      await api("/settings/relay", { method: "PUT", body: { mode: "existing", localHost: ip } });
      await load();
      setMessage({ ok: true, text: `Saved. The agent now reaches this machine at ${ip}.` });
    } catch (err) {
      setMessage({ ok: false, text: (err as Error).message });
    }
    setBusy(false);
  }

  async function remove() {
    if (!confirm("Forget the playit.gg key? Servers set to Hide my IP stay set that way, but they need it again before players can connect.")) return;
    await api("/settings/relay", { method: "DELETE" });
    await load();
  }

  if (!status) {
    // Nothing at all would look like the option is missing, so say what happened.
    return loadError ? (
      <section className="settings-card">
        <h2>Hide my IP (playit.gg)</h2>
        <p className="error">Could not load these settings: {loadError}. If this panel was updated recently, restart it and reload this page.</p>
      </section>
    ) : null;
  }
  const asking = !status.configured || editing;
  return (
    <section className="settings-card" ref={cardRef}>
      <h2>Hide my IP (playit.gg)</h2>
      <p className="muted">
        With a plain public server, players see your home IP address. Hide my IP sends them through a free relay from playit.gg instead: your friends install nothing, and you open no router ports. Turn it on per server from the server's
        menu. You need a free playit.gg account and an agent; if you already run one, paste its secret key here.
      </p>

      {status.configured && !editing && (
        <div className="dns-status">
          <p>
            <span className="dot online" /> Key saved · {status.mode === "managed" ? "Game Labs runs the agent" : "using the agent you already run"}
            {status.account.tunnels !== null && <> · {status.account.tunnels} tunnel{status.account.tunnels === 1 ? "" : "s"} on the account</>}
          </p>
          {status.account.problem && <p className="error">playit.gg: {status.account.problem}</p>}
          {status.agent.state === "stopped" && <p className="error">The agent container is not running.</p>}
          {status.warning && <p className="warn">{status.warning}</p>}
          {status.localNote && <p className="warn">{status.localNote}</p>}
          {status.mode === "existing" && status.localHost && <p className="muted small-text">The agent reaches this machine at <span className="mono">{status.localHost}</span>.</p>}
          {status.mode === "existing" && status.localNote && status.lanIp && !/^(127.|172.17.)/.test(status.lanIp) && status.localHost !== status.lanIp && (
            <div className="row">
              <button className="primary small" disabled={busy} onClick={() => void useLan(status.lanIp ?? "")}>
                Use {status.lanIp}
              </button>
            </div>
          )}
          <div className="row">
            <button className="ghost small" onClick={() => setEditing(true)}>
              Change
            </button>
            <button className="ghost small danger" onClick={remove}>
              Remove
            </button>
          </div>
        </div>
      )}

      {asking && (
        <form onSubmit={save} className="dns-form notify-form">
          <h3>1. Get the agent's secret key</h3>
          <ol className="steps">
            <li>
              Sign in at <span className="mono">playit.gg</span> (a free account is enough) and open your agent. If you have none yet, <strong>Add agent</strong> and choose Docker.
            </li>
            <li>Copy the agent's <strong>secret key</strong>.</li>
          </ol>
          <h3>2. Paste it here</h3>
          <input type="password" autoComplete="off" placeholder={status.configured ? "Key saved (paste a new one to replace it)" : "Secret key"} value={secret} onChange={(e) => setSecret(e.target.value)} />
          <p className="muted small-text">The key works like a password, so the panel stores it encrypted and never shows it again.</p>
          <h3>3. Who runs the agent?</h3>
          <label className="check">
            <input type="radio" name="relay-mode" checked={mode === "existing"} onChange={() => setMode("existing")} /> I already run it (for example in Dockhand or Docker). Game Labs only reads it.
          </label>
          <label className="check">
            <input type="radio" name="relay-mode" checked={mode === "managed"} onChange={() => setMode("managed")} /> Game Labs runs the agent for me, in a container next to the servers.
          </label>
          {mode === "existing" && (
            <>
              <input type="text" autoComplete="off" placeholder="Address the agent uses to reach this machine, e.g. 192.168.1.20" value={localHost} onChange={(e) => setLocalHost(e.target.value)} />
              <p className="muted small-text">
                This is where the playit.gg agent sends players' traffic: this machine's home network address{status.lanIp ? <> (<span className="mono">{status.lanIp}</span>)</> : ""}. Do not use <span className="mono">127.0.0.1</span> when the agent runs in its own Docker
                container, for example from Dockhand: inside that container it means the agent itself, not this machine. Leave it empty to use HOST_LAN_IP.
              </p>
              {status.lanIp && localHost !== status.lanIp && (
                <button type="button" className="ghost small" onClick={() => setLocalHost(status.lanIp ?? "")}>
                  Use {status.lanIp}
                </button>
              )}
            </>
          )}
          <div className="row">
            <button className="primary" disabled={(!secret && !status.configured) || busy}>
              {busy ? "Checking…" : "Check and save"}
            </button>
            {status.configured && (
              <button type="button" className="ghost" onClick={() => (setEditing(false), setSecret(""))}>
                Cancel
              </button>
            )}
          </div>
        </form>
      )}
      {message && <p className={message.ok ? "ok" : "error"}>{message.text}</p>}
    </section>
  );
}
