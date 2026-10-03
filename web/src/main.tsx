import { Component, StrictMode, useEffect, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { api, type AuthStatus } from "./api";
import { Login } from "./Login";
import { BackupsPage } from "./BackupsPage";
import { GameServers } from "./GameServers";
import { ServerDetail } from "./ServerDetail";
import type { Page } from "./Nav";
import { Settings } from "./Settings";
import "./styles.css";

function App() {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [page, setPage] = useState<Page>(() => (location.hash === "#settings" ? "settings" : location.hash === "#backups" ? "backups" : "servers"));
  const [serverId, setServerId] = useState<string | null>(() => location.hash.match(/^#server\/(.+)$/)?.[1] ?? null);
  const navigate = (p: Page) => (setServerId(null), setPage(p), history.replaceState(null, "", `#${p}`));
  const openServer = (id: string | null) => (setServerId(id), history.replaceState(null, "", id ? `#server/${id}` : "#servers"));
  const refresh = () => api<AuthStatus>("/auth/status").then(setStatus);
  useEffect(() => void refresh(), []);

  if (!status) return null;
  if (!status.authenticated) return <Login setup={status.setupRequired} onDone={refresh} />;
  const logout = () => api("/auth/logout", { method: "POST" }).then(refresh);
  if (page === "settings") return <Settings onLogout={logout} onNavigate={navigate} />;
  if (page === "backups") return <BackupsPage onLogout={logout} onNavigate={navigate} />;
  if (serverId) return <ServerDetail id={serverId} onBack={() => openServer(null)} onLogout={logout} onNavigate={navigate} />;
  return <GameServers onLogout={logout} onNavigate={navigate} onOpenServer={openServer} />;
}

/** Errors React cannot catch (event handlers, async code): show them instead of failing silently. */
function showFatal(message: string) {
  const el = document.createElement("div");
  el.setAttribute("style", "position:fixed;left:0;right:0;bottom:0;padding:12px 16px;background:#7f1d1d;color:#fff;font:13px monospace;z-index:99;white-space:pre-wrap");
  el.textContent = `Error: ${message}`;
  document.body.appendChild(el);
}
window.addEventListener("error", (e) => showFatal(e.message));
window.addEventListener("unhandledrejection", (e) => showFatal(String((e.reason as Error)?.message ?? e.reason)));

/** Show what went wrong instead of a blank page if a component throws. */
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main className="center">
        <div className="card login">
          <h1>Something went wrong</h1>
          <p className="error">{this.state.error.message}</p>
          <button className="primary" onClick={() => location.reload()}>
            Reload
          </button>
        </div>
      </main>
    );
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
