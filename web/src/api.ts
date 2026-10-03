export interface TemplateEnv {
  key: string;
  label: string;
  default?: string;
  required: boolean;
  secret: boolean;
  generate: boolean;
  help?: string;
}

export interface Template {
  id: string;
  name: string;
  image: string;
  maxPlayers?: number;
  join: { method: "direct" | "server-browser"; instructions?: string };
  ports: { name: string; default: number; protocol: "tcp" | "udp" }[];
  env: TemplateEnv[];
}

export interface Server {
  id: string;
  slug: string;
  name: string;
  templateId: string;
  templateName: string;
  status: "deploying" | "online" | "paused" | "offline" | "updating" | "error";
  access: "private" | "public";
  lastError: string | null;
  ports: { name: string; port: number; protocol: "tcp" | "udp" }[];
  secrets: string[];
  connect: { lan: string | null; public: string | null; instructions: string | null };
  pendingRules: { id: number; port: number; protocol: "tcp" | "udp" }[];
}

export interface Network {
  provider: "manual" | "upnp";
  lanIp: string | null;
  publicIp: string | null;
  ipError: string | null;
  reconcile: { at: string | null; problems: string[] };
  dns: { host: string; zone: string | null; lastUpdate: string | null; lastIp: string | null } | null;
  rules: { id: number; port: number; protocol: "tcp" | "udp"; confirmed: boolean; slug: string }[];
  mappings: { port: number; protocol: "tcp" | "udp"; description: string }[];
}

export interface AuthStatus {
  setupRequired: boolean;
  authenticated: boolean;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public data: Record<string, unknown>,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: init?.method ?? "GET",
    headers: init?.body ? { "content-type": "application/json" } : undefined,
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError((data as { error?: string }).error ?? res.statusText, data as Record<string, unknown>);
  return data as T;
}

export interface DnsStatus {
  configured: boolean;
  source: "env" | "app" | null;
  zone: string | null;
  host: string | null;
  tokenSet: boolean;
}

export type TokenCheck = { valid: false; error: string } | { valid: true; zones: string[]; zonesError: string | null };
