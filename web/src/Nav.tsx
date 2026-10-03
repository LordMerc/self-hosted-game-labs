import { useEffect, useState } from "react";
import { api, type AuthStatus } from "./api";
import { Icon } from "./Icons";

export type Page = "servers" | "backups" | "settings";

export function Nav({ page, onNavigate, onLogout }: { page: Page; onNavigate: (p: Page) => void; onLogout: () => void }) {
  const item = (p: Page, icon: "server" | "archive" | "settings", label: string) => (
    <a className={page === p ? "active" : ""} href={`#${p}`} onClick={(e) => (e.preventDefault(), onNavigate(p))}>
      <Icon name={icon} size={17} />
      {label}
    </a>
  );
  const [instance, setInstance] = useState<string | null>(null);
  useEffect(() => void api<AuthStatus>("/auth/status").then((s) => setInstance(s.instance), () => {}), []);
  return (
    <aside className="nav">
      <div className="brand">
        <span className="brand-mark">
          <Icon name="server" size={18} />
        </span>
        Game Labs
        {instance && <span className="instance-badge">{instance}</span>}
      </div>
      <div className="nav-label">Menu</div>
      <nav>
        {item("servers", "server", "Game servers")}
        {item("backups", "archive", "Backups")}
        {item("settings", "settings", "Settings")}
      </nav>
      <button className="nav-foot" onClick={onLogout}>
        <Icon name="signout" size={17} />
        Sign out
      </button>
    </aside>
  );
}
