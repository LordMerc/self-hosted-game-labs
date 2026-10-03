import { useState } from "react";
import { api, type ActivityItem, type Network, type ReachItem, type Server } from "./api";
import { ago as shortAgo } from "./format";
import { HiddenIp } from "./HiddenIp";
import { Icon } from "./Icons";
import { checkedAgo } from "./ServersTable";
import { NetworkSkeleton } from "./Skeleton";

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


type State = "ok" | "warn" | "bad" | "off";

interface Item {
  key: string;
  title: string;
  state: State;
  detail: React.ReactNode;
  action?: React.ReactNode;
  more?: React.ReactNode;
}

const stateIcon = { ok: "check", warn: "alert", bad: "alert", off: "info" } as const;

/** Ports each public server needs open on the router, in "port/protocol" form. */
const wanted = (servers: Server[]) => servers.filter((s) => s.access === "public" && (s.status === "online" || s.status === "paused")).flatMap((s) => s.ports.map((p) => `${p.port}/${p.protocol}`));

function Row({ item }: { item: Item }) {
  return (
    <li className={`health-item s-${item.state}`}>
      <span className="health-mark" aria-label={{ ok: "OK", warn: "Needs a look", bad: "Problem", off: "Not in use" }[item.state]} role="img">
        <Icon name={stateIcon[item.state]} size={15} />
      </span>
      <div className="health-body">
        <div className="health-title">{item.title}</div>
        <div className="health-detail">{item.detail}</div>
        {item.action && <div className="health-action">{item.action}</div>}
        {item.more}
      </div>
    </li>
  );
}

/**
 * The state of the way in from the internet, as a checklist: public IP, router ports, dynamic DNS and whether the servers
 * were actually reached from outside. Each line says what is wrong in plain words and offers the one thing to do about it.
 */
export function NetworkPanel({ network, servers, activity, onChange }: { network: Network | null; servers: Server[]; activity: ActivityItem[]; onChange: () => void }) {
  const [checking, setChecking] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [probing, setProbing] = useState(false);
  const [probeError, setProbeError] = useState("");
  const [probe, setProbe] = useState<{ via: string; results: ReachItem[] } | null>(null);
  if (!network) return <NetworkSkeleton />;

  const upnp = network.provider === "upnp";
  const confirm = (id: number, confirmed: boolean) => api(`/network/rules/${id}`, { method: "PUT", body: { confirmed } }).then(onChange);
  const ddns = () => api("/network/ddns", { method: "POST" }).then(onChange).catch((e) => alert(e.message));
  const recheck = async () => {
    setChecking(true);
    await Promise.resolve(onChange()).catch(() => undefined);
    setChecking(false);
  };
  async function runProbe() {
    setProbing(true);
    setProbeError("");
    try {
      const r = await api<{ via: string; results: ReachItem[] }>("/network/port-check", { method: "POST", body: {} });
      setProbe(r);
      onChange();
    } catch (e) {
      setProbeError((e as Error).message);
    }
    setProbing(false);
  }

  const updated = ago(network.dns?.lastUpdate ?? null);
  const pub = servers.filter((s) => s.access === "public" && s.status === "online");
  const need = wanted(servers);
  const open = new Set(network.mappings.map((m) => `${m.port}/${m.protocol}`));
  const opened = need.filter((k) => open.has(k)).length;
  const confirmed = network.rules.filter((r) => r.confirmed).length;

  const items: Item[] = [];

  items.push({
    key: "ip",
    title: "Public IP",
    state: network.publicIp ? "ok" : "bad",
    detail: network.publicIp ? (
      <>
        <HiddenIp value={network.publicIp} copy className="mono" />
        <div className="mono muted">{network.lanIp ? `LAN ${network.lanIp}` : "Set HOST_LAN_IP"}</div>
      </>
    ) : (
      <span className="error">{network.ipError ?? "Could not find the public IP"}</span>
    ),
    action: network.publicIp ? undefined : (
      <button className="text-btn" onClick={recheck} disabled={checking}>
        {checking ? "Checking…" : "Re-check"}
      </button>
    ),
  });

  if (upnp) {
    const bad = network.mappingsError !== null;
    items.push({
      key: "router",
      title: "UPnP port mapping",
      state: bad ? "bad" : need.length === 0 || opened === need.length ? "ok" : "warn",
      detail: bad ? `Can't read the router's port list: ${network.mappingsError}` : need.length === 0 ? "Nothing to open yet. Make a server public to open its ports." : `${opened} of ${need.length} port${need.length === 1 ? "" : "s"} open on the router`,
      action: (
        <button className="text-btn" onClick={() => setRulesOpen(!rulesOpen)} aria-expanded={rulesOpen}>
          {rulesOpen ? "Hide rules" : "View rules"}
        </button>
      ),
      more: rulesOpen && (
        <div className="health-more">
          {network.mappings.length === 0 && <p className="muted small-text">No ports are open on the router.</p>}
          {network.mappings.map((m) => (
            <div key={`${m.port}${m.protocol}`} className="map">
              <span className="chip mono">
                {m.port} <span className="proto">{m.protocol.toUpperCase()}</span>
              </span>
              <span className="muted">→ {m.description.replace("gamelabs:", "")}</span>
            </div>
          ))}
          <RouterDetails />
        </div>
      ),
    });
  } else {
    items.push({
      key: "router",
      title: "Port forwarding",
      state: network.rules.length === 0 || confirmed === network.rules.length ? "ok" : "warn",
      detail: network.rules.length === 0 ? "Rules appear here when you make a server public." : `${confirmed} of ${network.rules.length} router rule${network.rules.length === 1 ? "" : "s"} confirmed`,
      action: network.rules.length > 0 ? (
        <button className="text-btn" onClick={() => setRulesOpen(!rulesOpen)} aria-expanded={rulesOpen}>
          {rulesOpen ? "Hide rules" : "View rules"}
        </button>
      ) : undefined,
      more: rulesOpen && (
        <div className="health-more">
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
          <p className="muted small-text">Add each rule in your router, then tick it here.</p>
        </div>
      ),
    });
  }

  items.push(
    network.dns
      ? {
          key: "dns",
          title: "Dynamic DNS",
          state: "ok",
          detail: (
            <>
              <span className="mono">{network.dns.host}</span>
              <div className="muted">
                Cloudflare, DNS only · {updated ? `updated ${updated}` : "not updated yet"}
                {network.dns.lastIp && (
                  <>
                    {" · "}
                    <HiddenIp value={network.dns.lastIp} />
                  </>
                )}
              </div>
            </>
          ),
          action: (
            <button className="text-btn" onClick={ddns}>
              Update now
            </button>
          ),
        }
      : {
          key: "dns",
          title: "Dynamic DNS",
          state: "off",
          detail: "Not set up, so public servers are reached by IP address.",
          action: (
            <a className="text-btn" href="#settings">
              Set up in Settings
            </a>
          ),
        },
  );

  const untested = pub.filter((s) => !s.reachability);
  const stale = pub.filter((s) => s.reachability?.stale);
  const problems = pub.filter((s) => s.reachability?.state === "problem" || s.reachability?.state === "unknown");
  const reach: Item = {
    key: "reach",
    title: "External reachability",
    state: "off",
    detail: "",
  };
  if (!network.portCheck.enabled) {
    reach.detail = "The outside check is turned off. Set PORT_CHECK=on to use it.";
  } else if (pub.length === 0) {
    reach.detail = "Nothing to check: no public server is running.";
  } else if (problems.length > 0) {
    reach.state = "bad";
    reach.detail = problems.map((s) => `${s.name}: ${s.reachability!.text}`).join(". ");
  } else if (untested.length > 0) {
    reach.state = "warn";
    reach.detail = `${untested.map((s) => s.name).join(", ")} ${untested.length === 1 ? "hasn't" : "haven't"} been tested from outside your network yet.`;
  } else if (stale.length > 0) {
    reach.state = "warn";
    reach.detail = `${stale.map((s) => s.name).join(", ")}: the last check is out of date (${stale.some((s) => s.reachability!.stale === "ip-changed") ? "your public IP changed since" : "it is more than a day old"}). Run the check again to confirm.`;
  } else {
    const oldest = pub.map((s) => s.reachability!.at).sort()[0];
    reach.state = "ok";
    reach.detail = `${pub.length === 1 ? pub[0].name : `All ${pub.length} public servers`} reachable from the internet. ${checkedAgo(oldest)}.`;
  }
  if (network.portCheck.enabled && pub.length > 0) {
    reach.action = (
      <button className="act-btn" onClick={() => void runProbe()} disabled={probing}>
        <Icon name="radar" size={14} /> {probing ? "Checking…" : untested.length > 0 || problems.length > 0 || stale.length > 0 ? "Run check" : "Check again"}
      </button>
    );
    reach.more = (
      <>
        {probeError && <p className="error small-text">{probeError}</p>}
        {probe && probe.results.length === 0 && <p className="muted small-text">Nothing to check.</p>}
        {probe && probe.results.length > 0 && (
          <ul className="probe-results">
            {probe.results.map((i) => (
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
        <p className="muted small-text">Run check sends your public IP and the port number to {network.portCheck.via}. Nothing is sent otherwise. UDP games cannot be tested from outside; for those the panel shows whether the router forwards the port.</p>
      </>
    );
  }
  items.push(reach);

  const counted = items.filter((i) => i.state !== "off");
  const good = counted.filter((i) => i.state === "ok").length;

  return (
    <aside className="network" aria-label="Network health">
      <div className="net-head">
        <h2>
          <span className="net-mark">
            <Icon name="router" size={18} />
          </span>
          Network health
        </h2>
        <span className={`badge ${good === counted.length ? "ok" : "warn"}`}>
          <span className="dot" /> {good} of {counted.length} OK
        </span>
      </div>

      <ul className="health">
        {items.map((i) => (
          <Row key={i.key} item={i} />
        ))}
      </ul>

      {network.reconcile.problems.length > 0 && (
        <section className="attention">
          <h3>Needs attention</h3>
          {network.reconcile.problems.map((p) => (
            <p key={p} className="error small-text">
              {p}
            </p>
          ))}
        </section>
      )}

      {activity.length > 0 && (
        <section className="activity">
          <h3 className="eyebrow">Recent activity</h3>
          <ul>
            {activity.map((a) => (
              <li key={a.id} className={a.level}>
                <span className="activity-text">{a.server ? `${a.server}: ${a.message}` : a.message}</span>
                <time dateTime={a.at} title={new Date(a.at).toLocaleString()}>
                  {shortAgo(a.at)}
                </time>
              </li>
            ))}
          </ul>
        </section>
      )}

      <a className="net-link" href="#settings">
        Open network settings <Icon name="arrow" size={14} />
      </a>
    </aside>
  );
}
