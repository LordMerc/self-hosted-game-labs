import { api, type Network } from "./api";

export function NetworkPanel({ network, onChange }: { network: Network | null; onChange: () => void }) {
  if (!network) return null;
  const confirm = (id: number, confirmed: boolean) => api(`/network/rules/${id}`, { method: "PUT", body: { confirmed } }).then(onChange);
  const ddns = () => api("/network/ddns", { method: "POST" }).then(onChange).catch((e) => alert(e.message));

  return (
    <aside className="card network">
      <h2>Network</h2>
      <dl>
        <dt>Public IP</dt>
        <dd className="mono">{network.publicIp ?? <span className="error">{network.ipError ?? "unknown"}</span>}</dd>
        <dt>LAN address</dt>
        <dd className="mono">{network.lanIp ?? <span className="muted">set HOST_LAN_IP</span>}</dd>
        <dt>Port forwarding</dt>
        <dd>{network.provider === "upnp" ? "Automatic (UPnP)" : "Manual"}</dd>
      </dl>

      {network.dns ? (
        <section>
          <h3>Dynamic DNS</h3>
          <p className="mono">{network.dns.host}</p>
          <p className="muted">
            {network.dns.lastIp ? `→ ${network.dns.lastIp}, updated ${new Date(network.dns.lastUpdate ?? "").toLocaleString()}` : "Not updated yet"}
          </p>
          <button className="ghost small" onClick={ddns}>
            Update now
          </button>
        </section>
      ) : (
        <p className="muted">Cloudflare DNS is not configured, so public servers are reached by IP address.</p>
      )}

      {network.provider === "manual" && (
        <section>
          <h3>Router rules</h3>
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
        </section>
      )}

      {network.reconcile.problems.length > 0 && (
        <section>
          <h3>Needs attention</h3>
          {network.reconcile.problems.map((p) => (
            <p key={p} className="error small-text">
              {p}
            </p>
          ))}
        </section>
      )}

      {network.provider === "upnp" && network.mappings.length > 0 && (
        <section>
          <h3>Open ports</h3>
          {network.mappings.map((m) => (
            <p key={`${m.port}${m.protocol}`} className="mono">
              {m.protocol.toUpperCase()} {m.port} <span className="muted">{m.description.replace("gamelabs:", "")}</span>
            </p>
          ))}
        </section>
      )}
    </aside>
  );
}
