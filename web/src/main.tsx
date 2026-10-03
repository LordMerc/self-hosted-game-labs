import { StrictMode, useEffect, useState } from "react";
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

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
