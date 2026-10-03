import { useEffect, useState, type FormEvent } from "react";
import { api, type DnsStatus, type TokenCheck } from "./api";
import { Nav, type Page } from "./Nav";

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
            Cloudflare. You need a domain on Cloudflare (free plan is fine).
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
