export interface TemplateEnv {
  key: string;
  label: string;
  default?: string;
  required: boolean;
  secret: boolean;
  generate: boolean;
  help?: string;
  choices?: string[];
}

export interface Template {
  id: string;
  name: string;
  image: string;
  /** Hex colour for the game's card, or null (a colour is then picked from the id). */
  accent: string | null;
  /** URL of a picture the template ships, or null (the card shows a gradient). */
  artwork: string | null;
  maxPlayers?: number;
  notes?: string;
  /** Memory the game needs, in MB; a lower memory limit gets a warning. */
  minMemoryMb: number | null;
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
  /** Running, but the game has not opened its port yet (still downloading or loading). */
  starting: boolean;
  /** Caps on what the game may use; null = no limit. */
  limits: { cpus: number | null; memoryMb: number | null; warnings: string[] };
  access: "private" | "public";
  lastError: string | null;
  ports: { name: string; port: number; protocol: "tcp" | "udp" }[];
  secrets: string[];
  connect: { lan: string | null; public: string | null; instructions: string | null };
  pendingRules: { id: number; port: number; protocol: "tcp" | "udp" }[];
  reachability: Reachability | null;
  /** A newer version of the game's image was found by the last check. */
  update: { to: string } | null;
}

export interface OtherPanelServer {
  name: string;
  instance: string;
  slug: string;
  image: string;
  state: "running" | "paused" | "exited" | "missing";
  ports: { port: number; protocol: "tcp" | "udp" }[];
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
  mappingsError: string | null;
  portCheck: { enabled: boolean; via: string | null };
}

export interface ReachItem {
  serverId: string;
  name: string;
  port: number;
  protocol: "tcp" | "udp";
  state: "open" | "closed" | "unknown" | "forwarded" | "not-forwarded" | "stopped";
  detail: string;
}

export interface Reachability {
  state: "ok" | "problem" | "forwarded" | "unknown";
  text: string;
  /** When the answer was taken. */
  at: string;
  /** The public IP changed since the answer, or it is over a day old. */
  stale: "ip-changed" | "old" | null;
  /** A later check that could not finish; it did not replace the answer. */
  attempt: { at: string; text: string } | null;
}

export interface AuthStatus {
  setupRequired: boolean;
  authenticated: boolean;
  instance: string | null;
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

export type NotifyKind = "online" | "down" | "playerJoin" | "playerLeave" | "backupFailed";

export interface NotificationStatus {
  configured: boolean;
  kind: "discord" | "generic" | null;
  host: string | null;
  events: Record<NotifyKind, boolean>;
  lastSentAt: string | null;
  lastError: string | null;
}

export type TokenCheck = { valid: false; error: string } | { valid: true; zones: string[]; zonesError: string | null };

export interface Stats {
  host: {
    cpu: { percent: number | null; cores: number };
    memory: { usedBytes: number; totalBytes: number } | null;
    storage: { usedBytes: number; totalBytes: number } | null;
    network: { rxPerSec: number; txPerSec: number } | null;
    uptimeSec: number | null;
  };
  servers: Record<string, { cpuPercent: number | null; memBytes: number; players: { online: number; max: number } | null }>;
  history: {
    intervalSec: number;
    host: { cpu: (number | null)[]; rx: (number | null)[]; tx: (number | null)[]; players: (number | null)[] };
    servers: Record<string, { cpu: (number | null)[]; memBytes: (number | null)[]; players: (number | null)[] }>;
    peaks: { cpuPercent: number | null; playersToday: number | null; windowMinutes: number };
  };
  docker: { name: string; version: string } | null;
}

export interface ActivityItem {
  id: number;
  level: "info" | "warn" | "error";
  message: string;
  at: string;
  server: string | null;
}

const accents = new Map<string, string>();
/** Loads the templates and remembers each game's colour, so its icon looks the same on every page. */
export async function loadTemplates(): Promise<Template[]> {
  const list = await api<Template[]>("/templates");
  for (const t of list) if (t.accent) accents.set(t.id, t.accent);
  return list;
}
export const accentFor = (templateId: string) => accents.get(templateId) ?? null;

export interface Backup {
  name: string;
  sizeBytes: number;
  createdAt: string;
}

export interface BackupSettings {
  keep: number;
  minDays: number;
  everyHours: number;
}

export interface BackupGroup {
  slug: string;
  name: string;
  deleted: boolean;
  serverId: string | null;
  status: Server["status"] | null;
  templateId: string | null;
  templateName: string | null;
  backups: Backup[];
  totalBytes: number;
  saved: { name: string; templateId: string | null; env: Record<string, string>; savedSecrets: string[]; access: "private" | "public" } | null;
}

export interface ServerDetail {
  server: Server;
  env: { key: string; label: string; help: string | null; choices: string[] | null; required: boolean; secret: boolean; generate: boolean; value: string | null; isSet: boolean }[];
  minMemoryMb: number | null;
  console: { examples: string[] } | null;
  care: {
    timezone: string;
    settings: { restart: { enabled: boolean; time: string; warnMinutes: number }; update: { auto: boolean; time: string } };
    /** The game can show a message to the players in the game. */
    canWarn: boolean;
    lastRestartOn: string | null;
    image: { name: string; tag: string; pinned: boolean; moved: boolean };
    update: { checkedAt: string; available: boolean; via: "tag" | "image"; current: string; latest: string | null; note: string } | null;
    portsEditable: boolean;
  };
  events: { id: number; level: "info" | "warn" | "error"; message: string; at: string }[];
}

export interface UpdateState {
  enabled: boolean;
  lockedByEnv: boolean;
  current: string;
  comparable: boolean;
  latest: { version: string; name: string; url: string; publishedAt: string | null } | null;
  updateAvailable: boolean;
  checkedAt: string | null;
  error: string | null;
}
