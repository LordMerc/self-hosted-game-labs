import { Icon } from "./Icons";

export type Page = "servers" | "settings";

export function Nav({ page, onNavigate, onLogout }: { page: Page; onNavigate: (p: Page) => void; onLogout: () => void }) {
  const item = (p: Page, icon: "server" | "settings", label: string) => (
    <a className={page === p ? "active" : ""} href={`#${p}`} onClick={(e) => (e.preventDefault(), onNavigate(p))}>
      <Icon name={icon} size={17} />
      {label}
    </a>
  );
  return (
    <aside className="nav">
      <div className="brand">
        <span className="brand-mark">
          <Icon name="server" size={18} />
        </span>
        Game Labs
      </div>
      <div className="nav-label">Menu</div>
      <nav>
        {item("servers", "server", "Game servers")}
        {item("settings", "settings", "Settings")}
      </nav>
      <button className="nav-foot" onClick={onLogout}>
        <Icon name="signout" size={17} />
        Sign out
      </button>
    </aside>
  );
}
