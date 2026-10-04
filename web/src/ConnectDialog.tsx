import type { RelayInfo, Server } from "./api";
import { CopyButton } from "./CopyButton";
import { HiddenIp, isIpAddress } from "./HiddenIp";

const PLAYIT_TUNNELS = "https://playit.gg/account/tunnels";

const typeWord = {
  tcp: "Custom TCP",
  udp: "Custom UDP (or the game's own choice if playit.gg lists one, such as Palworld; both work)",
  both: "Custom TCP + UDP",
} as const;

/** "192.168.1.20:8211" into its two halves. */
const splitLocal = (local: string) => {
  const i = local.lastIndexOf(":");
  return i < 0 ? { ip: local, port: "" } : { ip: local.slice(0, i), port: local.slice(i + 1) };
};

/** One line of the playit.gg "Add Tunnel" form: what it is called there, and what to put in. */
function Field({ label, value, copy, serverName }: { label: string; value: string; copy?: boolean; serverName: string }) {
  return (
    <div className="relay-field">
      <span className="muted">{label}</span>
      <span className={copy ? "mono" : undefined}>{value}</span>
      {copy ? <CopyButton text={value} label={`Copy ${label.toLowerCase()} for ${serverName}`} /> : <span />}
    </div>
  );
}

/** What is still to do for Hide my IP: set up Game Labs' side first, then add each tunnel in the playit.gg dashboard. Shown only while the relay is not ready. */
function RelaySetup({ relay, serverName, onSettings }: { relay: RelayInfo; serverName: string; onSettings?: () => void }) {
  if (relay.state === "ready") return <p className="muted small-text">Send your friends the address at the top. They reach this server through playit.gg, so your home IP address is not shown to them.</p>;
  const missing = relay.tunnels.filter((t) => !t.address);
  const settings = onSettings && (
    <button className="text-btn" onClick={onSettings}>
      Open Settings
    </button>
  );
  if (relay.fix === "settings") {
    return (
      <div className="relay-setup">
        <p className="warn">{relay.problem ?? "Hide my IP needs one thing set up first."}</p>
        <p>Game Labs needs to know your playit.gg agent before it can send players through it. Open Settings, find <strong>Hide my IP (playit.gg)</strong>, and follow the three steps there. Then come back here.</p>
        {settings}
      </div>
    );
  }
  return (
    <div className="relay-setup">
      <p className="warn">{relay.state === "error" ? (relay.problem ?? "playit.gg could not be reached.") : (relay.problem ?? "playit.gg does not have this server's tunnels yet.")}</p>
      {relay.localNote && (
        <p className="warn small-text">
          {relay.localNote} {settings}
        </p>
      )}
      {relay.state === "setup" && missing.length > 0 && (
        <>
          <p>Do this once. It takes about a minute, and this window fills in the player address by itself when you are done.</p>
          <ol className="steps">
            <li>
              Open{" "}
              <a href={PLAYIT_TUNNELS} target="_blank" rel="noreferrer">
                playit.gg Tunnels
              </a>{" "}
              and sign in.
            </li>
            <li>
              Click <strong>Add Tunnel</strong> and fill the form in like the {missing.length === 1 ? "card" : "cards"} below, one {missing.length === 1 ? "tunnel" : "tunnel per card"}. Click <strong>Next</strong> to finish each one.
            </li>
            <li>Come back here. The address appears within a few seconds. You can leave this window open.</li>
          </ol>
          {missing.map((t) => {
            const { ip, port } = splitLocal(t.local);
            return (
              <div key={t.name} className="relay-card">
                <Field label="Name your tunnel" value={t.name} copy serverName={serverName} />
                <Field label="Tunnel Type" value={typeWord[t.protocol]} serverName={serverName} />
                <Field label="Public Endpoint" value="Free Network (whichever region is closest)" serverName={serverName} />
                <Field label="Assign to Agent" value="Your playit.gg agent (the one whose key you saved in Settings)" serverName={serverName} />
                <Field label="Local IP" value={ip} copy serverName={serverName} />
                <Field label="Local Port" value={port} copy serverName={serverName} />
                <Field label="Proxy Protocol" value="None" serverName={serverName} />
              </div>
            );
          })}
          <p className="muted small-text">The name matters: Game Labs finds your tunnel by it, so copy it exactly.</p>
        </>
      )}
    </div>
  );
}

/** Everything a player needs to join a server: the public and home-network addresses, the ports, and any game-specific steps. */
export function ConnectDialog({ server: s, onClose, onSettings }: { server: Server; onClose: () => void; onSettings?: () => void }) {
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
        {s.connect.relay && row(s.connect.public ? "For strangers (relay)" : "Share this address", s.connect.relay)}
        {s.connect.public && row(s.connect.relay ? "For friends (public)" : "Public address", s.connect.public, true)}
        {s.connect.lan && row(s.connect.relay || s.connect.public ? "At home only" : "Home network", s.connect.lan)}
        {s.connect.relay && s.connect.public && (
          <p className="muted small-text">The relay address keeps your home IP hidden, so it is the safe one to give to people you do not know. The public address goes straight to your home connection.</p>
        )}
        {s.hideIp && s.relay && <RelaySetup relay={s.relay} serverName={s.name} onSettings={onSettings} />}
        {s.hideIp && s.access === "private" && s.connect.lan && <p className="muted small-text">On your own home network you can use the "At home only" address instead; it does not need the relay.</p>}
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
