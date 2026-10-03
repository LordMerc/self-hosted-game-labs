import { useState, type FormEvent } from "react";
import { api } from "./api";

type PortSpec = { port: number; protocol: "tcp" | "udp" };

/** "25565/tcp, 19132/udp" (commas, spaces or new lines); a bare number means tcp. */
function parsePorts(text: string): PortSpec[] | string {
  const out: PortSpec[] = [];
  for (const tok of text.split(/[\s,]+/).filter(Boolean)) {
    const m = /^(\d{1,5})(?:\/(tcp|udp))?$/i.exec(tok);
    if (!m) return `"${tok}" is not a port. Write them like 25565/tcp or 19132/udp`;
    out.push({ port: Number(m[1]), protocol: (m[2]?.toLowerCase() as "tcp" | "udp" | undefined) ?? "tcp" });
  }
  return out;
}

/** One KEY=VALUE per line. */
function parseEnv(text: string): Record<string, string> | string {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const i = line.indexOf("=");
    if (i < 1) return `"${line.trim()}" needs an equals sign, like SERVER_NAME=My server`;
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

export function CustomDialog({ onClose, onDeployed }: { onClose: () => void; onDeployed: () => void }) {
  const [name, setName] = useState("");
  const [image, setImage] = useState("");
  const [ports, setPorts] = useState("");
  const [env, setEnv] = useState("");
  const [dataPath, setDataPath] = useState("");
  const [owner, setOwner] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    const p = parsePorts(ports);
    const v = parseEnv(env);
    if (typeof p === "string") return setError(p);
    if (typeof v === "string") return setError(v);
    setBusy(true);
    try {
      await api("/servers/custom", { method: "POST", body: { name, image, ports: p, env: v, dataPath: dataPath || undefined, dataOwner: owner || undefined } });
      onDeployed();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="backdrop">
      <form className="card dialog" onSubmit={submit}>
        <h2>Run a Docker image</h2>
        <p className="muted">For a game that has no template yet. It runs as an ordinary container with no extra privileges. Only use images you trust.</p>
        <label>
          Server name
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} placeholder="My Bedrock server" />
        </label>
        <label>
          Docker image
          <input value={image} onChange={(e) => setImage(e.target.value)} required placeholder="itzg/minecraft-bedrock-server:latest" autoComplete="off" spellCheck={false} />
        </label>
        <label>
          Ports the game uses
          <input value={ports} onChange={(e) => setPorts(e.target.value)} required placeholder="19132/udp" autoComplete="off" />
          <span className="muted">Players use these exact numbers, so they cannot be moved. If one is taken you will be told.</span>
        </label>
        <label>
          Settings (optional)
          <textarea value={env} onChange={(e) => setEnv(e.target.value)} rows={3} placeholder={"EULA=TRUE\nSERVER_NAME=My server"} spellCheck={false} />
          <span className="muted">One per line, as NAME=value. Names ending in PASSWORD, SECRET, TOKEN or KEY are hidden afterwards.</span>
        </label>
        <label>
          Where the game saves its files (optional)
          <input value={dataPath} onChange={(e) => setDataPath(e.target.value)} placeholder="/data" autoComplete="off" spellCheck={false} />
          <span className="muted">A folder inside the container. It is kept on this machine, backed up, and survives restarts and deleting the server.</span>
        </label>
        {dataPath && (
          <label>
            Folder owner (optional)
            <input value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="1000:1000" autoComplete="off" />
            <span className="muted">Only if the game says it cannot write to its folder. The user id and group id the game runs as.</span>
          </label>
        )}
        {error && <p className="error">{error}</p>}
        <div className="row end">
          <button type="button" className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={busy}>
            {busy ? "Deploying…" : "Deploy"}
          </button>
        </div>
      </form>
    </div>
  );
}
