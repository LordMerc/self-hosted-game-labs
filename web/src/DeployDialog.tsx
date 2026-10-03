import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError, type Template } from "./api";

type Plan = { name: string; port: number; protocol: string }[];

export function DeployDialog({ template, onClose, onDeployed }: { template: Template; onClose: () => void; onDeployed: () => void }) {
  const [name, setName] = useState(template.name);
  const [env, setEnv] = useState<Record<string, string>>(() => Object.fromEntries(template.env.map((e) => [e.key, e.default ?? ""])));
  const [plan, setPlan] = useState<Plan>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ ports: Plan }>(`/templates/${template.id}/plan`).then((r) => setPlan(r.ports)).catch((e) => setError(e.message));
  }, [template.id]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/servers", { method: "POST", body: { templateId: template.id, name, env } });
      onDeployed();
    } catch (err) {
      const apiErr = err as ApiError;
      const suggestion = apiErr.data?.suggestion as Plan | undefined;
      setError(suggestion ? `${apiErr.message}. Free ports: ${suggestion.map((p) => `${p.port}/${p.protocol}`).join(", ")}` : apiErr.message);
      setBusy(false);
    }
  }

  return (
    <div className="backdrop">
      <form className="card dialog" onSubmit={submit}>
        <h2>Deploy {template.name}</h2>
        <label>
          Server name
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} />
        </label>
        {template.env.map((v) => (
          <label key={v.key}>
            {v.label}
            {v.required && " *"}
            {v.choices ? (
              <select value={env[v.key]} required={v.required} onChange={(e) => setEnv({ ...env, [v.key]: e.target.value })}>
                {(!v.default || !v.required) && <option value="">{v.required ? "Choose…" : "Default"}</option>}
                {v.choices.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type={v.secret ? "password" : "text"}
                value={env[v.key]}
                placeholder={v.generate ? "Leave empty to generate one" : ""}
                autoComplete="off"
                required={v.required}
                onChange={(e) => setEnv({ ...env, [v.key]: e.target.value })}
              />
            )}
            {v.help && <span className="muted">{v.help}</span>}
          </label>
        ))}
        <div>
          <span className="muted">Ports (chosen automatically)</span>
          <div className="mono">{plan.map((p) => `${p.port}/${p.protocol}`).join("   ") || "…"}</div>
        </div>
        {template.notes && <p className="muted wrap">{template.notes}</p>}
        {template.join.method === "server-browser" && <p className="muted">{template.join.instructions}</p>}
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
