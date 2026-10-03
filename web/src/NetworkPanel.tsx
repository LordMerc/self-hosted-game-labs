import { useState } from "react";
import { api, type Network, type ReachItem, type Server } from "./api";
import { HiddenIp } from "./HiddenIp";
import { Icon } from "./Icons";

function ago(iso: string | null) {
  if (!iso) return null;
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)} h ago`;
  return `${Math.round(mins / 60 / 24)} d ago`;
}

/** Raw router reply, so an odd router can be diagnosed from a screenshot. */
function RouterDetails() {
  const [text, setText] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const load = () => {
    setOpen(true);
    api<{ output: string | null }>("/network/diagnostics").then((r) => setText(r.output ?? "(nothing)")).catch((e) => setText(`Error: ${e.message}`));
  };
  if (!open) {
    return (
      <button className="ghost small" onClick={load}>
        Show router details
      </button>
    );
  }
  return (
    <>
      <pre className="router-details mono">{text ?? "Asking the router..."}</pre>
      <button className="ghost small" onClick={() => setOpen(false)}>
        Hide router details
      </button>
    </>
  );
}

const reachTone: Record<ReachItem["state"], string> = { open: "online", forwarded: "online", closed: "error", "not-forwarded": "error", unknown: "paused", stopped: "paused" };
const reachWord: Record<ReachItem["state"], string> = { open: "Open", forwarded: "Forwarded", closed: "Closed", "not-forwarded": "Not forwarded", unknown: "Unknown", stopped: "Stopped" };

/** Why a port may be closed, in one line, from what the outside checker reported. */
function reachHint(i: ReachItem) {
  if (i.state !== "closed") return null;
  if (/refused/i.test(i.detail)) return "The connection reached your network, but nothing answered on that port. Is the game running and listening?";
  return "Nothing answered. Usually the router is not forwarding this port, or the internet provider blocks it.";
}

/** Asks an outside service to try each public server's TCP ports. Only runs when pressed, because it sends the public IP to that service. */
function PortCheck({ info, servers, onDone }: { info: Network["portCheck"]; servers: Server[]; onDone: () => void }) {
  const pub = servers.filter((s) => s.access === "public");
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [out, setOut] = useState<{ via: string; checkedAt: string; results: ReachItem[] } | null>(null);

  async function run() {
    setBusy(true);
    setError("");
    try {
      const r = await api<{ via: string; checkedAt: string; results: ReachItem[] }>("/network/port-check", { method: "POST", body: target ? { serverId: target } : {} });
      setOut(r);
      onDone();
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  }

  return (
    <section>
      <div className="sec-head">
        <h3>External port check</h3>
        <span className="muted small-text">{info.via ? `via ${info.via}` : "off"}</span>
      </div>
      <div className="probe">
        <select aria-label="Servers to check" value={target} onChange={(e) => setTarget(e.target.value)} disabled={!info.enabled || pub.length === 0 || busy}>
          <option value="">All public servers</option>
          {pub.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <button className="primary" onClick={() => void run()} disabled={!info.enabled || pub.length === 0 || busy}>
          <Icon name="radar" size={15} /> {busy ? "Checking…" : "Run"}
        </button>
      </div>
      {!info.enabled && <p className="muted small-text">Turned off. Set PORT_CHECK=on to use it.</p>}
      {info.enabled && pub.length === 0 && <p className="muted small-text">Make a server public to check it.</p>}
      {error && <p className="error small-text">{error}</p>}
      {out && out.results.length === 0 && <p className="muted small-text">Nothing to check.</p>}
      {out && out.results.length > 0 && (
        <ul className="probe-results">
          {out.results.map((i) => (
            <li key={`${i.serverId}${i.port}${i.protocol}`}>
              <div>
                <span className={`dot ${reachTone[i.state]}`} /> <strong>{i.name}</strong> <span className="mono">{i.port ? `${i.port} ${i.protocol.toUpperCase()}` : ""}</span> <span className="muted">{reachWord[i.state]}</span>
              </div>
              <div className="muted small-text wrap">{i.detail}</div>
              {reachHint(i) && <div className="warn small-text wrap">{reachHint(i)}</div>}
            </li>
          ))}
        </ul>
      )}
      <p className="muted small-text">
        {info.enabled ? `Pressing Run sends your public IP and the port number to ${info.via}. Nothing is sent otherwise. ` : ""}UDP games cannot be tested from outside; for those the panel shows whether the router forwards the port.
      </p>
    </section>
  );
}

export function NetworkPanel({ network, servers, onChange }: { network: Network | null; servers: Server[]; onChange: () => void }) {
  const [checking, setChecking] = useState(false);
  if (!network) return null;
  const confirm = (id: number, confirmed: boolean) => api(`/network/rules/${id}`, { method: "PUT", body: { confirmed } }).then(onChange);
  const ddns = () => api("/network/ddns", { method: "POST" }).then(onChange).catch((e) => alert(e.message));
  const recheck = async () => {
    setChecking(true);
    await Promise.resolve(onChange()).catch(() => undefined);
    setChecking(false);
  };
  const upnp = network.provider === "upnp";
  const updated = ago(network.dns?.lastUpdate ?? null);

  return (
    <aside className="network">
      <div className="net-head">
        <h2>
          <span className="net-mark">
            <Icon name="router" size={18} />
          </span>
          Network
        </h2>
        <span className={`badge ${network.publicIp ? "ok" : "bad"}`}>
          <span className="dot online" /> {network.publicIp ? "Online" : "No public IP"}
        </span>
      </div>

      <section>
        <div className="sec-head">
          <h3>Public IP</h3>
          <button className="text-btn" onClick={recheck} disabled={checking}>
            {checking ? "Checking…" : "Re-check"}
          </button>
        </div>
        <dl>
          <dt>Public IP</dt>
          <dd className="mono">
            {network.publicIp ? (
              <HiddenIp value={network.publicIp} copy />
            ) : (
              <span className="error">{network.ipError ?? "unknown"}</span>
            )}
          </dd>
          <dt>LAN address</dt>
          <dd className="mono">{network.lanIp ?? <span className="muted">set HOST_LAN_IP</span>}</dd>
        </dl>
      </section>

      <section>
        <div className="sec-head">
          <h3>{upnp ? "UPnP rules" : "Port forwarding"}</h3>
          <span className={`badge ${upnp ? "ok" : ""}`}>{upnp ? "Enabled" : "Manual"}</span>
        </div>
        {upnp ? (
          <>
            <p className="muted">
              {network.mappings.length === 0 ? "No ports open on the router" : `${network.mappings.length} port${network.mappings.length === 1 ? "" : "s"} open on the router`}
            </p>
            {network.mappingsError && <p className="error small-text">Can't read the router's port list: {network.mappingsError}</p>}
            {network.mappings.map((m) => (
              <div key={`${m.port}${m.protocol}`} className="map">
                <span className="chip mono">
                  {m.port} <span className="proto">{m.protocol.toUpperCase()}</span>
                </span>
                <span className="muted">→ {m.description.replace("gamelabs:", "")}</span>
              </div>
            ))}
            <RouterDetails />
          </>
        ) : (
          <>
            {network.rules.length === 0 && <p className="muted">Rules appear here when you make a server public.</p>}
            {network.rules.map((r) => (
              <label key={r.id} className="rule">
                <input type="checkbox" checked={r.confirmed} onChange={(e) => confirm(r.id, e.target.checked)} />
                <span>
                  <span className="mono">
                    {r.protocol.toUpperCase()} {r.port}
                  </span>{" "}
                  → {network.lanIp ?? "this machine"} <span className="muted">({r.slug})</span>
                </span>
              </label>
            ))}
            {network.rules.length > 0 && <p className="muted">Add each rule in your router, then tick it here.</p>}
          </>
        )}
      </section>

      <section>
        <div className="sec-head">
          <h3>Dynamic DNS</h3>
          {network.dns && (
            <span className="provider">
              <Icon name="cloud" size={15} /> Cloudflare
            </span>
          )}
        </div>
        {network.dns ? (
          <>
            <div className="sec-head tight">
              <span className="chip mono">
                <span className="proto">A</span> {network.dns.host}
              </span>
              <span className="badge">DNS only</span>
            </div>
            <dl>
              <dt>Last update</dt>
              <dd>
                {updated ? (
                  <>
                    {updated}
                    {network.dns.lastIp && (
                      <>
                        {" · "}
                        <HiddenIp value={network.dns.lastIp} />
                      </>
                    )}
                  </>
                ) : (
                  "Not updated yet"
                )}
              </dd>
            </dl>
            <p className="muted small-text">Proxy stays off. Cloudflare's proxy can't carry game traffic.</p>
            <button className="ghost small" onClick={ddns}>
              Update now
            </button>
          </>
        ) : (
          <p className="muted">Cloudflare DNS is not set up, so public servers are reached by IP address. <a href="#settings">Set it up in Settings</a>.</p>
        )}
      </section>

      <PortCheck info={network.portCheck} servers={servers} onDone={onChange} />

      {network.reconcile.problems.length > 0 && (
        <section>
          <div className="sec-head">
            <h3>Needs attention</h3>
          </div>
          {network.reconcile.problems.map((p) => (
            <p key={p} className="error small-text">
              {p}
            </p>
          ))}
        </section>
      )}
    </aside>
  );
}
