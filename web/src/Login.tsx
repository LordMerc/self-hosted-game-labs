import { useState, type FormEvent } from "react";
import { api } from "./api";

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
        <input type="password" autoFocus placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} />
        {error && <p className="error">{error}</p>}
        <button className="primary" type="submit">
          {setup ? "Create password" : "Sign in"}
        </button>
      </form>
    </main>
  );
}
