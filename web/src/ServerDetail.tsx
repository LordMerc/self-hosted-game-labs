import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { api, type ServerDetail as Detail, type Stats } from "./api";
import { Backups } from "./Backups";
import { CopyButton } from "./CopyButton";
import { Hint } from "./Hint";
import { HiddenIp, isIpAddress } from "./HiddenIp";
import { Icon } from "./Icons";
import { LogViewer } from "./LogViewer";
import { Nav, type Page } from "./Nav";

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
    try {
      await api(path, { method, body });
    } catch (e) {
      setError((e as Error).message);
    }
    await load();
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
  const primary = s ? (s.connect.public ?? s.connect.lan) : null;

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
                  <div className="seg">
                    <button className={s.access === "private" ? "on" : ""} disabled={locked || s.access === "private"} onClick={() => act(`/servers/${id}/access`, "PUT", { access: "private" })}>
                      <Icon name="lock" size={13} /> Private
                    </button>
                    <button
                      className={s.access === "public" ? "on public" : ""}
                      disabled={locked || s.status === "error" || s.access === "public"}
                      onClick={() => act(`/servers/${id}/access`, "PUT", { access: "public" })}
                    >
                      <Icon name="globe" size={13} /> Public
                    </button>
                  </div>
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

            <SettingsForm key={id} detail={detail} disabled={locked} onSaved={load} />

            {detail.console && <Console id={id} examples={detail.console.examples} running={s.status === "online"} />}

            <section className="settings-card">
              <h2>Recent activity</h2>
              {detail.events.length === 0 ? (
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

            <section className="settings-card danger-zone">
              <h2>Delete this server</h2>
              <p className="muted">
                Deleting removes the container and its router and DNS entries. The world data and backups stay on disk, so you can set it up again later. To delete the world data as well, a final backup is made first.
              </p>
              <div className="row">
                <button className="ghost danger" disabled={locked} onClick={remove}>
                  Delete server
                </button>
                <button className="ghost danger" disabled={locked} onClick={removeWithData}>
                  Delete server and world data…
                </button>
              </div>
            </section>
          </>
        )}
      </main>
      {logs && s && <LogViewer id={id} name={s.name} onClose={() => setLogs(false)} />}
      {backups && s && <Backups id={id} name={s.name} running={s.status === "online"} onClose={() => setBackups(false)} onChange={() => void load()} />}
    </div>
  );
}

function SettingsForm({ detail, disabled, onSaved }: { detail: Detail; disabled: boolean; onSaved: () => Promise<void> }) {
  const [name, setName] = useState(detail.server.name);
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(detail.env.map((e) => [e.key, e.value ?? ""])));
  const [reset, setReset] = useState<Set<string>>(new Set());
  const [shown, setShown] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");

  const changedEnv: Record<string, string> = {};
  for (const e of detail.env) {
    if (e.secret) {
      if (reset.has(e.key)) changedEnv[e.key] = "";
      else if (values[e.key]) changedEnv[e.key] = values[e.key];
    } else if (values[e.key] !== (e.value ?? "")) changedEnv[e.key] = values[e.key];
  }
  const envDirty = Object.keys(changedEnv).length > 0;
  const nameDirty = name.trim() !== detail.server.name;

  async function reveal(key: string) {
    try {
      const { value } = await api<{ value: string }>(`/servers/${detail.server.id}/secrets/${key}`);
      setShown((s) => ({ ...s, [key]: value || "(empty)" }));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function save(ev: FormEvent) {
    ev.preventDefault();
    setBusy(true);
    setError("");
    setNote("");
    try {
      const r = await api<{ restarting: boolean }>(`/servers/${detail.server.id}/settings`, {
        method: "PUT",
        body: { ...(nameDirty ? { name } : {}), ...(envDirty ? { env: changedEnv } : {}) },
      });
      setValues((v) => Object.fromEntries(Object.entries(v).map(([k, x]) => [k, detail.env.find((e) => e.key === k)?.secret ? "" : x])));
      setReset(new Set());
      setShown({});
      setNote(r.restarting ? "Saved. The server is restarting to apply the changes; your world is kept." : "Saved.");
      await onSaved();
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  }

  return (
    <form className="settings-card" onSubmit={save}>
      <h2>Settings</h2>
      <label className="field">
        <span>Name in the panel</span>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
      </label>
      {detail.env.map((e) => (
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
          ) : (
            <input value={values[e.key]} onChange={(ev) => setValues({ ...values, [e.key]: ev.target.value })} />
          )}
        </label>
      ))}
      <div className="row">
        <button className="primary" disabled={disabled || busy || (!envDirty && !nameDirty)}>
          {busy ? "Saving…" : envDirty ? "Save and restart" : "Save"}
        </button>
      </div>
      <p className="muted note">Changing a game setting restarts the server so it takes effect. Your world and backups are not touched. Changing only the name does not restart anything.</p>
      {error && <p className="error">{error}</p>}
      {note && <p className="muted">{note}</p>}
    </form>
  );
}

function Console({ id, examples, running }: { id: string; examples: string[]; running: boolean }) {
  const [command, setCommand] = useState("");
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

  return (
    <section className="settings-card">
      <h2>
        Console
        <Hint label="About the console">Sends a command to the running game server, the same as typing it into the server&apos;s own admin console. Commands are sent as-is, not run in a shell.</Hint>
      </h2>
      {!running && <p className="muted">Start the server to use the console.</p>}
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
    </section>
  );
}
