import type { RelayInfo, Server } from "./api";
import { CopyButton } from "./CopyButton";
import { HiddenIp, isIpAddress } from "./HiddenIp";

const protoWord = { tcp: "TCP", udp: "UDP", both: "TCP and UDP" } as const;

/** What is still to do in the playit.gg dashboard (or why the relay does not answer). Shown only while the relay is not ready. */
function RelaySetup({ relay }: { relay: RelayInfo }) {
  if (relay.state === "ready") return <p className="muted small-text">Players reach this server through playit.gg, so your home IP address is not shown to them.</p>;
  const missing = relay.tunnels.filter((t) => !t.address);
  return (
    <div className="relay-setup">
      {relay.state === "error" ? <p className="warn">{relay.problem ?? "playit.gg could not be reached."}</p> : <p className="warn">{relay.problem ?? "playit.gg does not have this server's tunnels yet."}</p>}
      {relay.state === "setup" && missing.length > 0 && (
        <>
          <p>
            In your playit.gg dashboard open <strong>Tunnels</strong>, choose the agent, and add {missing.length === 1 ? "this tunnel" : "these tunnels"}. The address shows up here by itself a few seconds later.
          </p>
          <ul className="small-text">
            {missing.map((t) => (
              <li key={t.name}>
                <span className="mono">{t.name}</span>: {protoWord[t.protocol]}, forwards to <span className="mono">{t.local}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/** Everything a player needs to join a server: the public and home-network addresses, the ports, and any game-specific steps. */
export function ConnectDialog({ server: s, onClose }: { server: Server; onClose: () => void }) {
  const row = (label: string, value: string, hide = false) => (
    <div className="connect-row">
      <span className="muted">{label}</span>
      <span className="mono">{hide && isIpAddress(value) ? <HiddenIp value={value} /> : value}</span>
      <CopyButton text={value} label={`Copy ${label.toLowerCase()} for ${s.name}`} />
    </div>
  );
  return (
    <div className="backdrop">
      <div className="card dialog connect">
        <div className="row between">
          <h2>Connect to {s.name}</h2>
          <button className="ghost" onClick={onClose}>
            Close
          </button>
        </div>
        {s.connect.relay && row("Address for players", s.connect.relay)}
        {s.connect.public && row("Public address", s.connect.public, true)}
        {s.connect.lan && row("Home network", s.connect.lan)}
        {s.access === "relay" && s.relay && <RelaySetup relay={s.relay} />}
        {s.access === "relay" && s.connect.lan && <p className="muted small-text">At home, use the home network address; it does not need the relay.</p>}
        {s.access === "public" && s.connect.lan && <p className="muted small-text">At home, use the home network address: the public one can fail from inside your own network.</p>}
        <div className="chips">
          {s.ports.map((p) => (
            <span key={`${p.port}${p.protocol}`} className="chip mono">
              {p.port} <span className="proto">{p.protocol.toUpperCase()}</span>
            </span>
          ))}
        </div>
        {s.connect.instructions && <p className="wrap">{s.connect.instructions}</p>}
      </div>
    </div>
  );
}
