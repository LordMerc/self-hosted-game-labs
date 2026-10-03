import { eq } from "drizzle-orm";
import type { Config } from "../config.js";
import type { Db } from "../db/index.js";
import { schema } from "../db/index.js";
import { decrypt, encrypt } from "../dns/settings.js";
import { DEFAULT_INSTANCE, names } from "../instance.js";

export const NOTIFY_KINDS = ["online", "down", "playerJoin", "playerLeave", "backupFailed"] as const;
export type NotifyKind = (typeof NOTIFY_KINDS)[number];

export interface NotifyEvent {
  kind: NotifyKind;
  /** The server's display name. */
  server: string;
  detail?: string;
  /** Set for player events: the count after the change, and how many came or went. */
  players?: { online: number; max: number; change: number };
  /** For `down`: the server never came up, as opposed to having been running. */
  failedToStart?: boolean;
}

/** What the server service talks to. Kept small so tests can swap in a recorder. */
export interface NotifySink {
  wants(kind: NotifyKind): boolean;
  notify(event: NotifyEvent): void;
}

export type WebhookKind = "discord" | "generic";

export interface NotificationStatus {
  configured: boolean;
  /** Which message format is used, picked from the address. Never the address itself: it contains a secret. */
  kind: WebhookKind | null;
  host: string | null;
  events: Record<NotifyKind, boolean>;
  lastSentAt: string | null;
  lastError: string | null;
}

/** Player leaves are chatty, so they start off. */
const DEFAULT_EVENTS: Record<NotifyKind, boolean> = { online: true, down: true, playerJoin: true, playerLeave: false, backupFailed: true };

const K_URL = "notify_url";
const K_EVENTS = "notify_events";

export class WebhookError extends Error {}
/** The address was fine but the message did not get through. */
export class WebhookDeliveryError extends WebhookError {}

/** Check a pasted address and say which message format it needs. Any http(s) address works; Discord's gets rich embeds. */
export function parseWebhook(raw: string): { url: string; kind: WebhookKind; host: string } {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new WebhookError("That doesn't look like a web address. Paste the full webhook URL.");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new WebhookError("The webhook address must start with https:// (or http:// for a service on your own network)");
  const discord = /(^|\.)(discord|discordapp)\.com$/.test(u.hostname) && u.pathname.startsWith("/api/webhooks/");
  return { url: u.toString(), kind: discord ? "discord" : "generic", host: u.hostname };
}

interface Message {
  title: string;
  text: string;
  /** Discord embed colour. */
  color: number;
}

const GREEN = 0x3fb950;
const RED = 0xf85149;
const BLUE = 0x58a6ff;
const AMBER = 0xd29922;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The wording of each event. No addresses or passwords ever go in here. */
export function describe(e: NotifyEvent): Message {
  switch (e.kind) {
    case "online":
      return { title: `${e.server} is online`, text: e.detail ?? "Players can join.", color: GREEN };
    case "down":
      return {
        title: e.failedToStart ? `${e.server} failed to start` : `${e.server} went down`,
        text: e.detail ?? "It stopped without anyone stopping it from the panel. Open its logs in the panel to see why.",
        color: RED,
      };
    case "playerJoin":
    case "playerLeave": {
      const p = e.players ?? { online: 0, max: 0, change: 1 };
      const n = Math.abs(p.change);
      const verb = e.kind === "playerJoin" ? "joined" : "left";
      return { title: `${e.server}: ${plural(n, "player")} ${verb}`, text: p.max > 0 ? `${p.online} of ${p.max} players online` : `${plural(p.online, "player")} online`, color: BLUE };
    }
    case "backupFailed":
      return { title: `${e.server}: backup failed`, text: e.detail ?? "The backup could not be made.", color: AMBER };
  }
}

/** The JSON a webhook receives. Discord gets an embed; any other service gets `content` and `text` (what Discord-, Slack- and Mattermost-style hooks read) plus plain fields. */
export function buildPayload(kind: WebhookKind, e: NotifyEvent | "test", instance: string, now = new Date()): Record<string, unknown> {
  const m: Message = e === "test" ? { title: "Test message from Game Labs", text: "If you can read this, notifications are working.", color: GREEN } : describe(e);
  const tag = instance === DEFAULT_INSTANCE ? "" : `[${instance}] `;
  if (kind === "discord") {
    return {
      username: "Game Labs",
      // Without this, a server named "@everyone" would ping the whole channel.
      allowed_mentions: { parse: [] },
      embeds: [{ title: `${tag}${m.title}`.slice(0, 256), description: m.text.slice(0, 2000), color: m.color, timestamp: now.toISOString() }],
    };
  }
  const line = `${tag}${m.title}. ${m.text}`;
  return {
    content: line,
    text: line,
    event: e === "test" ? "test" : e.kind,
    server: e === "test" ? null : e.server,
    title: `${tag}${m.title}`,
    message: m.text,
    instance,
    at: now.toISOString(),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Sends server events to a webhook. The address is stored encrypted (it holds a secret token, like the Cloudflare
 * token does). Sending never throws into the caller and never blocks it: a dead webhook must not break a server.
 */
export class Notifier implements NotifySink {
  private chain: Promise<void> = Promise.resolve();
  private lastSentAt: string | null = null;
  private lastError: string | null = null;

  constructor(
    private readonly db: Db,
    private readonly config: Config,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  private get(key: string): string | null {
    return this.db.select().from(schema.settings).where(eq(schema.settings.key, key)).get()?.value ?? null;
  }

  private set(key: string, value: string) {
    this.db.insert(schema.settings).values({ key, value }).onConflictDoUpdate({ target: schema.settings.key, set: { value } }).run();
  }

  private savedUrl(): string | null {
    const enc = this.get(K_URL);
    return enc ? decrypt(enc, this.config.SESSION_SECRET) : null;
  }

  private events(): Record<NotifyKind, boolean> {
    const out = { ...DEFAULT_EVENTS };
    try {
      const saved = JSON.parse(this.get(K_EVENTS) ?? "{}") as Record<string, unknown>;
      for (const k of NOTIFY_KINDS) if (typeof saved[k] === "boolean") out[k] = saved[k];
    } catch {
      /* unreadable: use the defaults */
    }
    return out;
  }

  status(): NotificationStatus {
    const url = this.savedUrl();
    const hook = url ? parseWebhook(url) : null;
    return { configured: !!hook, kind: hook?.kind ?? null, host: hook?.host ?? null, events: this.events(), lastSentAt: this.lastSentAt, lastError: this.lastError };
  }

  wants(kind: NotifyKind): boolean {
    return !!this.savedUrl() && this.events()[kind];
  }

  /** Save from the Settings page. A blank address keeps the saved one; `events` only changes the toggles that are given. */
  save(input: { url?: string; events?: Partial<Record<NotifyKind, boolean>> }) {
    if (input.url?.trim()) this.set(K_URL, encrypt(parseWebhook(input.url).url, this.config.SESSION_SECRET));
    else if (!this.savedUrl()) throw new WebhookError("Paste a webhook address");
    if (input.events) {
      const merged = this.events();
      for (const k of NOTIFY_KINDS) if (typeof input.events[k] === "boolean") merged[k] = input.events[k];
      this.set(K_EVENTS, JSON.stringify(merged));
    }
    this.lastError = null;
  }

  clear() {
    for (const k of [K_URL, K_EVENTS]) this.db.delete(schema.settings).where(eq(schema.settings.key, k)).run();
    this.lastError = null;
  }

  /** Send a test message to the given address (not yet saved) or, without one, the saved address. Reports the failure to the caller. */
  async sendTest(url?: string): Promise<void> {
    const raw = url?.trim() || this.savedUrl();
    if (!raw) throw new WebhookError("Paste a webhook address first");
    const hook = parseWebhook(raw);
    await this.post(hook.url, buildPayload(hook.kind, "test", names.instance));
  }

  notify(event: NotifyEvent): void {
    if (!this.wants(event.kind)) return;
    const url = this.savedUrl();
    if (!url) return;
    const hook = parseWebhook(url);
    // One at a time and in order, so several events at once do not trip Discord's rate limit or arrive shuffled.
    this.chain = this.chain
      .then(() => this.post(hook.url, buildPayload(hook.kind, event, names.instance)))
      .then(
        () => {
          this.lastSentAt = new Date().toISOString();
          this.lastError = null;
        },
        (e: unknown) => {
          this.lastError = e instanceof Error ? e.message : String(e);
        },
      );
  }

  /** Wait until everything queued so far has been sent. For tests and shutdown. */
  idle(): Promise<void> {
    return this.chain;
  }

  private async post(url: string, body: Record<string, unknown>): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetchFn(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000), redirect: "error" });
      } catch (e) {
        // The error text is kept short and never repeats the address, which contains the secret.
        const cause = (e as { cause?: { code?: string } }).cause?.code;
        throw new WebhookDeliveryError(`Could not reach the webhook${cause ? ` (${cause})` : ""}`);
      }
      if (res.status === 429 && attempt === 0) {
        const wait = Number(((await res.json().catch(() => ({}))) as { retry_after?: number }).retry_after);
        await sleep(Math.min(Number.isFinite(wait) && wait > 0 ? wait * 1000 : 1000, 5000));
        continue;
      }
      if (res.ok) return;
      const said = ((await res.json().catch(() => ({}))) as { message?: unknown }).message;
      throw new WebhookDeliveryError(`The webhook answered ${res.status}${typeof said === "string" ? `: ${said.slice(0, 120)}` : ""}`);
    }
  }
}
