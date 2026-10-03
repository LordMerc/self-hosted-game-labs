import type { AuthStatus, UpdateState } from "./api";
import { Icon } from "./Icons";
import { pageData, prefetch, useApi } from "./store";

export type Page = "servers" | "backups" | "settings";

export function Nav({ page, onNavigate, onLogout }: { page: Page; onNavigate: (p: Page) => void; onLogout: () => void }) {
  const item = (p: Page, icon: "server" | "archive" | "settings", label: string) => (
    <a className={page === p ? "active" : ""} href={`#${p}`} onClick={(e) => (e.preventDefault(), onNavigate(p))} onPointerEnter={() => prefetch(pageData[p])} onPointerDown={() => prefetch(pageData[p])} onFocus={() => prefetch(pageData[p])}>
      <Icon name={icon} size={17} />
      {label}
    </a>
  );
  const instance = useApi<AuthStatus>("/auth/status").data?.instance ?? null;
  const version = useApi<UpdateState>("/updates").data ?? null;
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
      <div className="nav-foot">
        {version && (
          <div className="version">
            <span className="mono">{/^\d/.test(version.current) ? `v${version.current}` : version.current.startsWith("dev-") ? "dev build" : version.current}</span>
            {version.updateAvailable && version.latest && (
              <a className="new-version" href={version.latest.url} target="_blank" rel="noreferrer" title={`Version ${version.latest.version} is available`}>
                <Icon name="arrowup" size={12} />
                {version.latest.version} available
              </a>
            )}
          </div>
        )}
        <a className="nav-plain" href="https://github.com/LordMerc/self-hosted-game-labs" target="_blank" rel="noreferrer">
          <Icon name="github" size={17} />
          Star on GitHub
        </a>
        <button className="nav-plain" onClick={onLogout}>
          <Icon name="signout" size={17} />
          Sign out
        </button>
      </div>
    </aside>
  );
}
