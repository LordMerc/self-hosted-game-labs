import type { Server } from "./api";
import { CopyButton } from "./CopyButton";
import { HiddenIp, isIpAddress } from "./HiddenIp";

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
        {s.connect.public && row("Public address", s.connect.public, true)}
        {s.connect.lan && row("Home network", s.connect.lan)}
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
