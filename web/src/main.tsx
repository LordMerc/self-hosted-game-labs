import { Component, StrictMode, useEffect, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { api, type AuthStatus } from "./api";
import { Login } from "./Login";
import { GameServers } from "./GameServers";
import "./styles.css";

function App() {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const refresh = () => api<AuthStatus>("/auth/status").then(setStatus);
  useEffect(() => void refresh(), []);

  if (!status) return null;
  if (!status.authenticated) return <Login setup={status.setupRequired} onDone={refresh} />;
  return <GameServers onLogout={() => api("/auth/logout", { method: "POST" }).then(refresh)} />;
}

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
