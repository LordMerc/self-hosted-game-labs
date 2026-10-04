import { useEffect, useState } from "react";
import { api, type RelayInfo, type RelayStatus, type Server } from "./api";
import { CopyButton } from "./CopyButton";
import { HiddenIp, isIpAddress } from "./HiddenIp";

const PLAYIT_TUNNELS = "https://playit.gg/account/tunnels";

const typeWord = { tcp: "Custom TCP", udp: "Custom UDP", both: "Custom TCP + UDP" } as const;

/** "192.168.1.20:8211" into its two halves. */
const splitLocal = (local: string) => {
  const i = local.lastIndexOf(":");
  return i < 0 ? { ip: local, port: "" } : { ip: local.slice(0, i), port: local.slice(i + 1) };
};

/** An address that an agent in its own container could use to reach this machine: not loopback and not Docker's internal network. */
const usableLan = (ip: string | null): ip is string => !!ip && !/^(127\.|172\.17\.|localhost$|::1$)/i.test(ip);

/**
 * Where the playit.gg agent sends players' traffic. A wrong value (127.0.0.1 from inside the agent's own container) is the usual reason
 * a tunnel connects but nobody gets in, so it can be fixed right here, and the tunnels below update at once.
 */
function AgentAddress({ onChanged }: { onChanged?: () => void }) {
  const [status, setStatus] = useState<RelayStatus | null>(null);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    api<RelayStatus>("/settings/relay")
      .then((s) => (setStatus(s), setValue(s.localHost ?? "")))
      .catch(() => setStatus(null));
  }, []);
  if (!status || !status.configured || status.mode !== "existing") return null;
  async function save(next: string) {
    setBusy(true);
    setMessage(null);
    try {
      await api("/settings/relay", { method: "PUT", body: { mode: "existing", localHost: next } });
      setValue(next);
      setStatus(await api<RelayStatus>("/settings/relay"));
      setMessage({ ok: true, text: "Saved. The tunnels below use this address now." });
      onChanged?.();
    } catch (e) {
      setMessage({ ok: false, text: (e as Error).message });
    }
    setBusy(false);
  }
  const suggestion = usableLan(status.lanIp) && status.localHost !== status.lanIp ? status.lanIp : null;
  return (
    <div className="agent-address">
      <label>
        <span>
          Address your playit.gg agent uses to reach this machine <span className="muted">(this computer's home network address, such as 192.168.1.20)</span>
        </span>
      </label>
      <div className="row">
        <input type="text" autoComplete="off" placeholder="192.168.1.20" value={value} onChange={(e) => setValue(e.target.value)} />
        <button className="primary" disabled={busy || !value.trim() || value.trim() === status.localHost} onClick={() => void save(value.trim())}>
          {busy ? "Saving…" : "Save"}
        </button>
        {suggestion && (
          <button className="ghost" disabled={busy} onClick={() => void save(suggestion)}>
            Use {suggestion}
          </button>
        )}
      </div>
      {message && <p className={message.ok ? "ok small-text" : "error small-text"}>{message.text}</p>}
    </div>
  );
}

/** What is still to do for Hide my IP: set up Game Labs' side first, then add each tunnel in the playit.gg dashboard. Shown only while the relay is not ready. */
function RelaySetup({ relay, serverName, onSettings, onChanged }: { relay: RelayInfo; serverName: string; onSettings?: () => void; onChanged?: () => void }) {
  if (relay.state === "ready") return <p className="muted small-text">The relay address goes through playit.gg, so your home IP address is not shown to the people who use it.</p>;
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
        <p className="small-text">
          Game Labs needs to know your playit.gg agent before it can send players through it. Open Settings, find <strong>Hide my IP (playit.gg)</strong>, and follow the three steps there. {settings}
        </p>
      </div>
    );
  }
  const local = missing[0] ? splitLocal(missing[0].local).ip : null;
  return (
    <div className="relay-setup">
      <p className="warn">{relay.state === "error" ? (relay.problem ?? "playit.gg could not be reached.") : (relay.problem ?? "playit.gg does not have this server's tunnels yet.")}</p>
      {relay.localNote && <p className="warn small-text">{relay.localNote}</p>}
      <AgentAddress onChanged={onChanged} />
      {relay.state === "setup" && missing.length > 0 && (
        <>
          <ol className="steps">
            <li>
              Open{" "}
              <a href={PLAYIT_TUNNELS} target="_blank" rel="noreferrer">
                playit.gg Tunnels
              </a>{" "}
              and click <strong>Add Tunnel</strong>.
            </li>
            <li>
              Add {missing.length === 1 ? "this tunnel" : `these ${missing.length} tunnels`} with the values below, then click <strong>Next</strong>.
            </li>
            <li>Come back here: the address appears by itself within a few seconds.</li>
          </ol>
          <dl className="relay-const">
            <dt>Public Endpoint</dt>
            <dd>Free Network (closest region)</dd>
            <dt>Assign to Agent</dt>
            <dd>The agent whose key you saved in Settings</dd>
            <dt>Local IP</dt>
            <dd>
              {local && (
                <>
                  <span className="mono">{local}</span> <CopyButton text={local} label={`Copy local IP for ${serverName}`} />
                </>
              )}
            </dd>
            <dt>Proxy Protocol</dt>
            <dd>None</dd>
          </dl>
          <table className="relay-table">
            <thead>
              <tr>
                <th>Name your tunnel</th>
                <th>Tunnel Type</th>
                <th>Local Port</th>
              </tr>
            </thead>
            <tbody>
              {missing.map((t) => {
                const { port } = splitLocal(t.local);
                return (
                  <tr key={t.name}>
                    <td>
                      <span className="mono">{t.name}</span> <CopyButton text={t.name} label={`Copy tunnel name ${t.name}`} />
                    </td>
                    <td>{typeWord[t.protocol]}</td>
                    <td>
                      <span className="mono">{port}</span> <CopyButton text={port} label={`Copy local port ${port} for ${serverName}`} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="muted small-text">Copy each name exactly: Game Labs finds the tunnel by it. If playit.gg lists the game by name (such as Palworld), that works too.</p>
        </>
      )}
    </div>
  );
}

/** Everything a player needs to join a server: the relay, public and home-network addresses, the ports, and any game-specific steps. */
export function ConnectDialog({ server: s, onClose, onSettings, onChanged }: { server: Server; onClose: () => void; onSettings?: () => void; onChanged?: () => void }) {
  const cell = (label: string, value: string, hide = false) => (
    <div className="connect-cell" key={label}>
      <span className="muted small-text">{label}</span>
      <div className="connect-value">
        <span className="mono">{hide && isIpAddress(value) ? <HiddenIp value={value} /> : value}</span>
        <CopyButton text={value} label={`Copy ${label.toLowerCase()} for ${s.name}`} />
      </div>
    </div>
  );
  const both = !!(s.connect.relay && s.connect.public);
  const wide = s.hideIp && !!s.relay && s.relay.state !== "ready";
  return (
    <div className="backdrop">
      <div className={`card dialog connect${wide ? " wide" : ""}`}>
        <div className="row between">
          <h2>Connect to {s.name}</h2>
          <button className="ghost" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="connect-grid">
          {s.connect.relay && cell(both ? "For strangers (relay)" : "Share this address", s.connect.relay)}
          {s.connect.public && cell(s.connect.relay ? "For friends (public)" : "Public address", s.connect.public, true)}
          {s.connect.lan && cell(s.connect.relay || s.connect.public ? "At home only" : "Home network", s.connect.lan)}
        </div>
        {both && <p className="muted small-text">The relay address keeps your home IP hidden, so it is the safe one for people you do not know. The public address goes straight to your home connection.</p>}
        {s.hideIp && s.relay && <RelaySetup relay={s.relay} serverName={s.name} onSettings={onSettings} onChanged={onChanged} />}
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
