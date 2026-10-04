import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { api, type RelayStatus, type ServerDetail as Detail, type Stats } from "./api";
import { Backups } from "./Backups";
import { PortField, ScheduleFields, useUpkeep } from "./Care";
import { ConnectDialog } from "./ConnectDialog";
import { CopyButton } from "./CopyButton";
import { Hint } from "./Hint";
import { HiddenIp, isIpAddress } from "./HiddenIp";
import { Icon } from "./Icons";
import { LimitFields, limitInputFrom, limitText, limitsFromInput, memoryWarning } from "./Limits";
import { LogViewer } from "./LogViewer";
import { Nav, type Page } from "./Nav";
import { openRelaySettings } from "./relayFocus";

const statusLabel = { online: "Running", paused: "Paused", offline: "Stopped", deploying: "Deploying", updating: "Restarting to apply changes", error: "Error" } as const;

function bytes(n: number) {
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (n >= 1000 && i < units.length - 1) (n /= 1000), i++;
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}

export function ServerDetail({ id, onBack, onLogout, onNavigate }: { id: string; onBack: () => void; onLogout: () => void; onNavigate: (p: Page) => void }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [stats, setStats] = useState<Stats["servers"][string] | null>(null);
  const [error, setError] = useState("");
  const [logs, setLogs] = useState(false);
  const [backups, setBackups] = useState(false);
  const [connect, setConnect] = useState(false);
  const [tab, setTab] = useState<"console" | "activity">("console");

  const load = useCallback(async () => {
    try {
      setDetail(await api<Detail>(`/servers/${id}`));
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }, [id]);

  useEffect(() => {
    void load();
    const busy = detail?.server.status === "deploying" || detail?.server.status === "updating";
    const t = setInterval(() => void load(), busy ? 2000 : 8000);
    return () => clearInterval(t);
  }, [load, detail?.server.status]);

  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const s = await api<Stats>("/stats");
        if (!stop) setStats(s.servers[id] ?? null);
      } catch {
        /* keep the last numbers */
      }
      if (!stop) timer = setTimeout(tick, 5000);
    };
    void tick();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [id]);

  async function act(path: string, method = "POST", body?: unknown) {
    setError("");
    let ok = true;
    try {
      await api(path, { method, body });
    } catch (e) {
      ok = false;
      setError((e as Error).message);
    }
    await load();
    return ok;
  }

  /** Hide my IP needs a saved playit.gg key; without one this goes to Settings. Otherwise the connect window opens straight away, since that is where the next steps are. */
  async function setAccess(access: "private" | "public" | "relay") {
    if (access === "relay") {
      const configured = await api<RelayStatus>("/settings/relay").then((r) => r.configured, () => null);
      if (configured === false) {
        if (confirm("Hide my IP needs your playit.gg secret key first. Open Settings to add it?")) openRelaySettings(onNavigate);
        return;
      }
    }
    if ((await act(`/servers/${id}/access`, "PUT", { access })) && access === "relay") setConnect(true);
  }

  async function remove() {
    if (!detail) return;
    if (!confirm(`Delete ${detail.server.name}? The container is removed; world data and backups are kept on disk.`)) return;
    try {
      await api(`/servers/${id}`, { method: "DELETE" });
      onBack();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function removeWithData() {
    if (!detail) return;
    const typed = prompt(`This deletes the world data too. A final backup is made first, so you can still bring it back.\n\nType the server name to confirm: ${detail.server.name}`);
    if (typed === null) return;
    try {
      await api(`/servers/${id}?deleteData=true&confirmName=${encodeURIComponent(typed)}`, { method: "DELETE" });
      onBack();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const s = detail?.server;
  const locked = s?.status === "deploying" || s?.status === "updating";
  const activeTab = detail?.console ? tab : "activity";
  const primary = s ? (s.connect.relay ?? s.connect.public ?? s.connect.lan) : null;

  return (
    <div className="shell">
      <Nav page="servers" onNavigate={onNavigate} onLogout={onLogout} />
      <main className="content detail">
        <button className="link back" onClick={onBack}>
          ← Game servers
        </button>
        {error && <p className="error banner">{error}</p>}
        {!s || !detail ? (
          !error && <p className="muted">Loading…</p>
        ) : (
          <>
            <header className="page-head">
              <div>
                <h1>{s.name}</h1>
                <div className="muted">
                  {s.templateName} ·{" "}
                  <span className={`status ${s.starting ? "deploying" : s.status}`}>
                    <span className={`dot ${s.starting ? "deploying" : s.status}`} /> {s.starting ? "Starting" : statusLabel[s.status]}
                  </span>
                </div>
              </div>
              <div className="row">
                {s.status === "online" ? (
                  <button className="ghost" onClick={() => act(`/servers/${id}/stop`)}>
                    Stop
                  </button>
                ) : (
                  <button className="primary" disabled={locked} onClick={() => act(`/servers/${id}/${s.status === "error" ? "retry" : "start"}`)}>
                    {s.status === "error" ? "Retry" : "Start"}
                  </button>
                )}
                <button className="ghost" disabled={s.status !== "online"} onClick={() => act(`/servers/${id}/restart`)}>
                  Restart
                </button>
                <button className="ghost" disabled={locked} onClick={() => setLogs(true)}>
                  Logs
                </button>
                <button className="ghost" disabled={locked} onClick={() => setBackups(true)}>
                  Backups
                </button>
              </div>
            </header>
            {s.lastError && <p className="error banner">{s.lastError}</p>}

            <div className="detail-grid">
              <div className="detail-side">
                <section className="settings-card">
                  <h2>Overview</h2>
                  <dl className="facts">
                    <dt>Address</dt>
                    <dd className="mono">
                      {primary && isIpAddress(primary) && primary === s.connect.public ? <HiddenIp value={primary} /> : (primary ?? "—")}
                      {primary && <CopyButton text={primary} label="Copy address" />}
                      {s.connect.public && s.connect.lan && <div className="muted small-text">On your home network: {s.connect.lan}</div>}
                      {s.connect.instructions && <div className="muted small-text wrap">{s.connect.instructions}</div>}
                    </dd>
                    <dt>Ports</dt>
                    <dd>
                      <div className="chips">
                        {s.ports.map((p) => (
                          <span key={`${p.port}${p.protocol}`} className="chip mono" title={p.name}>
                            {p.port} <span className="proto">{p.protocol.toUpperCase()}</span>
                          </span>
                        ))}
                      </div>
                    </dd>
                    <dt>Access</dt>
                    <dd>
                      {s.access === "public" ? "Public" : s.access === "relay" ? "Hidden IP (playit.gg)" : "Private"}
                      {s.access === "relay" && s.relay && s.relay.state !== "ready" && (
                        <div className="small-text">
                          <span className="warn">{s.relay.fix === "settings" ? "Needs a playit.gg key." : "Relay needs setup."}</span>{" "}
                          <button className="text-btn" onClick={() => (s.relay?.fix === "settings" ? openRelaySettings(onNavigate) : setConnect(true))}>
                            {s.relay.fix === "settings" ? "Open Settings" : "Finish setup"}
                          </button>
                        </div>
                      )}
                    </dd>
                    <dt>Version</dt>
                    <dd>
                      <span className="mono wrap">{detail.care.image.name}</span>
                      {detail.care.image.pinned && !detail.care.image.moved && <div className="muted small-text">The version this game was tested with.</div>}
                      {detail.care.image.moved && <div className="muted small-text">Updated from the panel.</div>}
                      {detail.care.update?.available && <div className="update-note small-text">{detail.care.update.latest ? `${detail.care.update.latest} is available.` : "An update is available."}</div>}
                    </dd>
                    <dt>Limit</dt>
                    <dd>
                      {limitText(s.limits) ?? <span className="muted">None (can use the whole machine)</span>}
                      {s.limits.warnings.map((w) => (
                        <div key={w} className="warn small-text wrap">{w}</div>
                      ))}
                    </dd>
                    {stats && (
                      <>
                        <dt>Using</dt>
                        <dd>
                          CPU {stats.cpuPercent == null ? "—" : `${stats.cpuPercent.toFixed(stats.cpuPercent < 10 ? 1 : 0)}%`} · {bytes(stats.memBytes)} memory
                          {stats.players && <> · {stats.players.online} / {stats.players.max} players</>}
                        </dd>
                      </>
                    )}
                  </dl>
                </section>

                <section className="settings-card danger-zone">
                  <h2>Danger zone</h2>
                  <p className="muted small-text">
                    Deleting removes the container and its router and DNS entries. The world data and backups stay on disk. Deleting the world data too makes a final backup first.
                  </p>
                  <div className="row wrap-row">
                    <button className="ghost danger" disabled={locked} onClick={remove}>
                      Delete server
                    </button>
                    <button className="ghost danger" disabled={locked} onClick={removeWithData}>
                      Delete server and world data…
                    </button>
                  </div>
                </section>
              </div>

              <div className="detail-main">
                <SettingsForm key={id} detail={detail} disabled={locked} onSaved={load} onAccess={setAccess} />

                <section className="settings-card">
                  <div className="tabs-bar" role="tablist">
                    {detail.console && (
                      <button role="tab" aria-selected={activeTab === "console"} className={activeTab === "console" ? "on" : ""} onClick={() => setTab("console")}>
                        Console
                      </button>
                    )}
                    <button role="tab" aria-selected={activeTab === "activity"} className={activeTab === "activity" ? "on" : ""} onClick={() => setTab("activity")}>
                      Recent activity
                    </button>
                  </div>
                  {activeTab === "console" && detail.console ? (
                    <Console id={id} examples={detail.console.examples} offNotice={detail.console.offNotice} running={s.status === "online"} disabled={locked} onApplied={load} />
                  ) : detail.events.length === 0 ? (
                    <p className="muted">Nothing yet.</p>
                  ) : (
                    <ul className="events">
                      {detail.events.map((e) => (
                        <li key={e.id} className={e.level}>
                          <span className="muted mono">{new Date(e.at).toLocaleString()}</span> {e.message}
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              </div>
            </div>
          </>
        )}
      </main>
      {connect && s && <ConnectDialog server={s} onClose={() => setConnect(false)} onSettings={() => openRelaySettings(onNavigate)} />}
      {logs && s && <LogViewer id={id} name={s.name} onClose={() => setLogs(false)} />}
      {backups && s && <Backups id={id} name={s.name} running={s.status === "online"} onClose={() => setBackups(false)} onChange={() => void load()} />}
    </div>
  );
}

function SettingsForm({ detail, disabled, onSaved, onAccess }: { detail: Detail; disabled: boolean; onSaved: () => Promise<void>; onAccess: (access: "private" | "public" | "relay") => Promise<void> }) {
  const [name, setName] = useState(detail.server.name);
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(detail.env.map((e) => [e.key, e.value ?? ""])));
  const [reset, setReset] = useState<Set<string>>(new Set());
  const [shown, setShown] = useState<Record<string, string>>({});
  const [limits, setLimits] = useState(() => limitInputFrom(detail.server.limits));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const up = useUpkeep(detail, onSaved);
  const s = detail.server;

  const changedEnv: Record<string, string> = {};
  for (const e of detail.env) {
    if (e.secret) {
      if (reset.has(e.key)) changedEnv[e.key] = "";
      else if (values[e.key]) changedEnv[e.key] = values[e.key];
    } else if (values[e.key] !== (e.value ?? "")) changedEnv[e.key] = values[e.key];
  }
  const envDirty = Object.keys(changedEnv).length > 0;
  const nameDirty = name.trim() !== s.name;
  const typedLimits = limitsFromInput(limits);
  const limitsDirty = typeof typedLimits !== "string" && (typedLimits.cpus !== s.limits.cpus || typedLimits.memoryMb !== s.limits.memoryMb);
  const settingsDirty = envDirty || nameDirty || limitsDirty;

  async function reveal(key: string) {
    try {
      const { value } = await api<{ value: string }>(`/servers/${s.id}/secrets/${key}`);
      setShown((x) => ({ ...x, [key]: value || "(empty)" }));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  // One Save for the game settings, the limits and the schedule: each part is sent only when it changed.
  async function save(ev: FormEvent) {
    ev.preventDefault();
    if (typeof typedLimits === "string") return setError(typedLimits);
    setBusy(true);
    setError("");
    setNote("");
    try {
      let restarting = false;
      if (settingsDirty) {
        const r = await api<{ restarting: boolean }>(`/servers/${s.id}/settings`, {
          method: "PUT",
          body: { ...(nameDirty ? { name } : {}), ...(envDirty ? { env: changedEnv } : {}), ...(limitsDirty ? typedLimits : {}) },
        });
        restarting = r.restarting;
        setValues((v) => Object.fromEntries(Object.entries(v).map(([k, x]) => [k, detail.env.find((e) => e.key === k)?.secret ? "" : x])));
        setReset(new Set());
        setShown({});
      }
      if (up.dirty) await up.save();
      setNote(restarting ? "Saved. The server is restarting to apply the changes; your world is kept." : "Saved.");
      await onSaved();
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  }

  const field = (e: Detail["env"][number]) => (
    <label key={e.key} className="field">
      <span>
        {e.label}
        {e.required && " *"}
        {e.help && <Hint label={`About ${e.label}`}>{e.help}</Hint>}
      </span>
      {e.secret ? (
        <>
          <div className="row">
            <input
              type="password"
              autoComplete="new-password"
              value={reset.has(e.key) ? "" : values[e.key]}
              placeholder={reset.has(e.key) ? (e.generate ? "A new one will be made" : "Will be removed") : e.isSet ? "Unchanged (type to replace)" : "Not set"}
              disabled={reset.has(e.key)}
              onChange={(ev) => setValues({ ...values, [e.key]: ev.target.value })}
            />
            <button type="button" className="ghost small" onClick={() => void reveal(e.key)}>
              Show current
            </button>
            {!e.required || e.generate ? (
              <button
                type="button"
                className="ghost small"
                onClick={() => setReset((r) => (r.has(e.key) ? new Set([...r].filter((k) => k !== e.key)) : new Set(r).add(e.key)))}
              >
                {reset.has(e.key) ? "Undo" : e.generate ? "Make a new one" : "Remove"}
              </button>
            ) : null}
          </div>
          {shown[e.key] && <span className="mono small-text">{shown[e.key]}</span>}
        </>
      ) : e.choices ? (
        <select value={values[e.key]} onChange={(ev) => setValues({ ...values, [e.key]: ev.target.value })}>
          {!e.required && <option value="">Default</option>}
          {e.choices.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      ) : (
        <input value={values[e.key]} onChange={(ev) => setValues({ ...values, [e.key]: ev.target.value })} />
      )}
    </label>
  );

  const secrets = detail.env.filter((e) => e.secret);
  const plain = detail.env.filter((e) => !e.secret);
  const anyDirty = settingsDirty || up.dirty;

  return (
    <form className="settings-card settings-form" onSubmit={save}>
      <div className="form-head">
        <h2>Settings</h2>
        <button className="primary" disabled={disabled || busy || !anyDirty}>
          {busy ? "Saving…" : envDirty || limitsDirty ? "Save and restart" : "Save"}
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      {note && <p className="muted">{note}</p>}

      <fieldset className="group">
        <legend>General</legend>
        <div className="field-grid">
          <label className="field">
            <span>Name in the panel</span>
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
          </label>
          {plain.map(field)}
        </div>
      </fieldset>

      <fieldset className="group">
        <legend>Access</legend>
        <div className="field-grid">
          <div className="field">
            <span>
              Who can join
              <Hint label="About access">Private servers can only be joined from your home network. Public servers are opened on your router, so players see your home IP. "Hide my IP" sends players through the free playit.gg relay instead. This takes effect straight away, without Save.</Hint>
            </span>
            <div className="seg">
              <button type="button" className={s.access === "private" ? "on" : ""} disabled={disabled || s.access === "private"} onClick={() => void onAccess("private")}>
                <Icon name="lock" size={13} /> Private
              </button>
              <button
                type="button"
                className={s.access === "public" ? "on public" : ""}
                disabled={disabled || s.status === "error" || s.access === "public"}
                onClick={() => void onAccess("public")}
              >
                <Icon name="globe" size={13} /> Public
              </button>
              <button
                type="button"
                className={s.access === "relay" ? "on public" : ""}
                disabled={disabled || s.status === "error" || s.access === "relay"}
                title="Players connect through playit.gg, so your home IP stays hidden"
                onClick={() => void onAccess("relay")}
              >
                <Icon name="shield" size={13} /> Hide my IP
              </button>
            </div>
          </div>
          <PortField detail={detail} disabled={disabled} onChanged={onSaved} />
        </div>
      </fieldset>

      {secrets.length > 0 && (
        <fieldset className="group">
          <legend>Passwords</legend>
          <div className="field-grid">{secrets.map(field)}</div>
        </fieldset>
      )}

      <fieldset className="group">
        <legend>Limits</legend>
        <div className="field-grid">
          <LimitFields fieldClass="field" value={limits} onChange={setLimits} warning={memoryWarning(limits, s.templateName, detail.minMemoryMb)} />
        </div>
      </fieldset>

      <fieldset className="group">
        <legend>Schedule</legend>
        <ScheduleFields detail={detail} up={up} disabled={disabled} />
      </fieldset>

      <p className="muted note">Changing a game setting or a limit restarts the server so it takes effect. Your world and backups are not touched. Changing only the name or the schedule does not restart anything.</p>
    </form>
  );
}

function Console({ id, examples, offNotice, running, disabled, onApplied }: { id: string; examples: string[]; offNotice: string | null; running: boolean; disabled: boolean; onApplied: () => Promise<void> }) {
  const [command, setCommand] = useState("");
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState("");
  const [history, setHistory] = useState<{ command: string; output: string; ok: boolean }[]>([]);
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => end.current?.scrollIntoView({ block: "nearest" }), [history]);

  async function run(ev: FormEvent) {
    ev.preventDefault();
    const c = command.trim();
    if (!c) return;
    setBusy(true);
    try {
      const r = await api<{ output: string; exitCode: number | null }>(`/servers/${id}/console`, { method: "POST", body: { command: c } });
      setHistory((h) => [...h, { command: c, output: r.output || "(no output)", ok: r.exitCode === 0 || r.exitCode === null }]);
      setCommand("");
    } catch (e) {
      setHistory((h) => [...h, { command: c, output: (e as Error).message, ok: false }]);
    }
    setBusy(false);
  }

  // An older server whose container was made before the panel turned the console's backend on: one click recreates it (the world is kept).
  async function apply() {
    setApplying(true);
    setApplyError("");
    try {
      await api(`/servers/${id}/apply`, { method: "POST" });
      await onApplied();
    } catch (e) {
      setApplyError((e as Error).message);
    }
    setApplying(false);
  }

  if (offNotice) {
    return (
      <div className="console">
        <p className="muted small-text">{offNotice}</p>
        {applyError && <p className="error">{applyError}</p>}
        <div className="row">
          <button type="button" className="primary" onClick={apply} disabled={applying || disabled}>
            {applying ? "Applying…" : "Apply settings"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="console">
      <p className="muted small-text">
        {running ? "Sends a command to the running game server, the same as typing it into its own admin console." : "Start the server to use the console."}
        <Hint label="About the console">Commands are sent as-is, not run in a shell.</Hint>
      </p>
      {history.length > 0 && (
        <div className="console-out mono">
          {history.map((h, i) => (
            <div key={i}>
              <div className="console-cmd">&gt; {h.command}</div>
              <pre className={h.ok ? "" : "error"}>{h.output}</pre>
            </div>
          ))}
          <div ref={end} />
        </div>
      )}
      <form className="row" onSubmit={run}>
        <input className="grow" value={command} onChange={(e) => setCommand(e.target.value)} placeholder="Type a command" disabled={!running || busy} maxLength={500} aria-label="Console command" />
        <button className="primary" disabled={!running || busy || !command.trim()}>
          {busy ? "Running…" : "Run"}
        </button>
      </form>
      {examples.length > 0 && (
        <div className="chips console-chips">
          {examples.map((x) => (
            <button key={x} type="button" className="chip mono" disabled={!running} onClick={() => setCommand(x.replace(/_/g, " "))}>
              {x.replace(/_/g, " ")}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
