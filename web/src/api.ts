export interface Template {
  id: string;
  name: string;
  image: string;
  maxPlayers?: number;
  join: { method: "direct" | "server-browser"; instructions?: string };
  ports: { name: string; default: number; protocol: "tcp" | "udp" }[];
}

export interface Server {
  id: string;
  slug: string;
  name: string;
  templateId: string;
  status: "deploying" | "online" | "paused" | "offline" | "updating" | "error";
  access: "private" | "public";
  ports: { name: string; port: number; protocol: "tcp" | "udp" }[];
}

export interface AuthStatus {
  setupRequired: boolean;
  authenticated: boolean;
}

export async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: init?.method ?? "GET",
    headers: init?.body ? { "content-type": "application/json" } : undefined,
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? res.statusText);
  return data as T;
}
