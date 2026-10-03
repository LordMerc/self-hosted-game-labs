import { useState, type FormEvent } from "react";
import { api } from "./api";

/** Plain HTTP is normal on a home network, but not for a name on the internet: the password would travel in the clear. */
export function insecureOnTheInternet(loc: { protocol: string; hostname: string } = location): boolean {
  if (loc.protocol !== "http:") return false;
  const h = loc.hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.includes(":")) return false; // IPv6 literals are almost always local
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) {
    const [a, b] = h.split(".").map(Number);
    return !(a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127));
  }
  return h.includes(".") && !/\.(local|lan|home|home\.arpa|internal|ts\.net)$/.test(h);
}

export function Login({ setup, onDone }: { setup: boolean; onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    try {
      await api(setup ? "/auth/setup" : "/auth/login", { method: "POST", body: { password } });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <main className="center">
      <form className="card login" onSubmit={submit}>
        <h1>{setup ? "Set an admin password" : "Sign in"}</h1>
        <p className="muted">
          {setup
            ? "This is the first run. Choose a password; it protects the panel, which controls Docker on this machine."
            : "Self Hosted Game Labs"}
        </p>
        {insecureOnTheInternet() && (
          <p className="warn small-text">
            This page is not using HTTPS, so your password would be sent unprotected. Put the panel behind an HTTPS reverse proxy before using it from the internet (see docs/exposing-the-panel.md).
          </p>
        )}
        <input type="password" autoFocus placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} />
        {error && <p className="error">{error}</p>}
        <button className="primary" type="submit">
          {setup ? "Create password" : "Sign in"}
        </button>
      </form>
    </main>
  );
}
