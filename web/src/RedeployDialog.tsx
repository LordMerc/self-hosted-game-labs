import { useState, type FormEvent } from "react";
import { api, type Backup, type BackupGroup, type Template } from "./api";

/** Set a deleted server up again from one of its backups. Saved settings are filled in; saved passwords stay on the server and are kept unless replaced. */
export function RedeployDialog({ group, backup, templates, onClose, onDone }: { group: BackupGroup; backup: Backup; templates: Template[]; onClose: () => void; onDone: () => void }) {
  const saved = group.saved;
  const [templateId, setTemplateId] = useState(saved?.templateId ?? group.templateId ?? "");
  const template = templates.find((t) => t.id === templateId);
  const [name, setName] = useState(saved?.name ?? group.name);
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [pub, setPub] = useState(saved?.access === "public");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const fromSaved = saved && saved.templateId === templateId;
  const keptSecret = (key: string) => !!fromSaved && saved.savedSecrets.includes(key);
  const value = (key: string, fallback = "") => typed[key] ?? (fromSaved ? saved.env[key] : undefined) ?? fallback;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!template) return setError("Choose which game this backup belongs to");
    setBusy(true);
    setError("");
    const env = Object.fromEntries(template.env.map((v) => [v.key, value(v.key, v.default)]));
    try {
      await api(`/backups/${group.slug}/${backup.name}/redeploy`, { method: "POST", body: { name, templateId, env, access: pub ? "public" : "private" } });
      onDone();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="backdrop">
      <form className="card dialog" onSubmit={submit}>
        <h2>Set up {group.name} again</h2>
        <p className="muted">
          This creates the server again and puts the world from <span className="mono">{backup.name}</span> in place before it first starts.{" "}
          {saved ? "The settings it had are filled in below." : "The settings it had were not saved, so check them below."}
        </p>
        {!saved?.templateId && (
          <label>
            Game
            <select value={templateId} onChange={(e) => setTemplateId(e.target.value)} required>
              <option value="" disabled>
                Choose the game…
              </option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          Server name
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} />
        </label>
        {template?.env.map((v) => (
          <label key={v.key}>
            {v.label}
            {v.required && " *"}
            {v.choices ? (
              <select value={value(v.key, v.default)} required={v.required} onChange={(e) => setTyped({ ...typed, [v.key]: e.target.value })}>
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
                value={value(v.key, v.default)}
                placeholder={keptSecret(v.key) ? "Keep the saved password" : v.generate ? "Leave empty to generate one" : ""}
                autoComplete="off"
                required={v.required && !keptSecret(v.key)}
                onChange={(e) => setTyped({ ...typed, [v.key]: e.target.value })}
              />
            )}
            {v.help && <span className="muted">{v.help}</span>}
          </label>
        ))}
        <label className="check">
          <input type="checkbox" checked={pub} onChange={(e) => setPub(e.target.checked)} />
          Make it public once it is running
        </label>
        <p className="muted">Ports are picked automatically, so they can differ from before (a custom image keeps its ports and tells you if one is taken).</p>
        {error && <p className="error">{error}</p>}
        <div className="row end">
          <button type="button" className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={busy || !template}>
            {busy ? "Setting up…" : "Set up again"}
          </button>
        </div>
      </form>
    </div>
  );
}
