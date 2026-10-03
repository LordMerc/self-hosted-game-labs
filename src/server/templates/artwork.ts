import { createHash } from "node:crypto";
import { lookup as dnsLookup } from "node:dns";
import { mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import https from "node:https";
import { isIP } from "node:net";
import path from "node:path";
import { artworkProblem, isArtworkUrl, type GameTemplate } from "../../shared/template.js";

export const ARTWORK_MAX_BYTES = 2 * 1024 * 1024;
export const ARTWORK_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;

export type ArtworkType = "image/png" | "image/jpeg" | "image/webp";
const EXT: Record<ArtworkType, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };
const TYPE_OF_EXT: Record<string, ArtworkType> = { png: "image/png", jpg: "image/jpeg", webp: "image/webp" };

/** What the picture really is, from its first bytes. The server's Content-Type is not trusted. */
export function sniffImage(b: Buffer): ArtworkType | null {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}

/** Whether an address belongs to the public internet. Loopback, private, link-local, multicast and similar ranges are not, so a link cannot point the panel at your own network. */
export function isPublicAddress(address: string): boolean {
  const v = isIP(address);
  if (v === 4) {
    const [a, b] = address.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && (b === 168 || (b === 0 && address.startsWith("192.0.0.")))) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    return true;
  }
  if (v === 6) {
    const a = address.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
    if (mapped) return isPublicAddress(mapped[1]);
    if (a === "::" || a === "::1") return false;
    if (/^f[cd]/.test(a) || /^fe[89ab]/.test(a) || a.startsWith("ff")) return false;
    return true;
  }
  return false;
}

export interface Fetched {
  body: Buffer;
}
/** Downloads one link. Injectable, so tests never touch the network. */
export type ArtworkFetcher = (url: string, limits: { timeoutMs: number; maxBytes: number }) => Promise<Fetched>;

/**
 * The real download: https only, a short overall deadline, a size cap, at most a few redirects (each one checked again as https),
 * and the address the name resolves to is checked when connecting, so it cannot be a private one.
 */
export const httpsFetcher: ArtworkFetcher = (url, { timeoutMs, maxBytes }) =>
  new Promise((resolve, reject) => {
    const deadline = setTimeout(() => fail(new Error("timed out")), timeoutMs);
    let active: import("node:http").ClientRequest | null = null;
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(deadline);
      fn();
    };
    const fail = (e: Error) =>
      finish(() => {
        active?.destroy();
        reject(e);
      });

    const get = (target: string, redirects: number) => {
      const problem = artworkProblem(target);
      if (problem) return fail(new Error(`refusing ${target}: ${problem}`));
      active = https.get(
        target,
        {
          headers: { accept: "image/png,image/jpeg,image/webp", "user-agent": "self-hosted-game-labs" },
          lookup: (host, opts, cb) =>
            dnsLookup(host, { ...opts, all: true }, (err, addrs) => {
              if (err) return (cb as (e: Error) => void)(err);
              const ok = (addrs as { address: string; family: number }[]).filter((a) => isPublicAddress(a.address));
              if (ok.length === 0) return (cb as (e: Error) => void)(new Error("host does not resolve to a public address"));
              if (opts.all) return (cb as unknown as (e: null, a: unknown) => void)(null, ok);
              (cb as unknown as (e: null, a: string, f: number) => void)(null, ok[0].address, ok[0].family);
            }),
        },
        (res) => {
          const status = res.statusCode ?? 0;
          if (status >= 300 && status < 400 && res.headers.location) {
            res.resume();
            if (redirects >= MAX_REDIRECTS) return fail(new Error("too many redirects"));
            try {
              return get(new URL(res.headers.location, target).toString(), redirects + 1);
            } catch {
              return fail(new Error("bad redirect"));
            }
          }
          if (status !== 200) {
            res.resume();
            return fail(new Error(`server answered ${status}`));
          }
          const declared = Number(res.headers["content-length"]);
          if (Number.isFinite(declared) && declared > maxBytes) {
            res.resume();
            return fail(new Error("picture is too large"));
          }
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (c: Buffer) => {
            size += c.length;
            if (size > maxBytes) return fail(new Error("picture is too large"));
            chunks.push(c);
          });
          res.on("end", () => finish(() => resolve({ body: Buffer.concat(chunks) })));
          res.on("error", fail);
        },
      );
      active.on("error", fail);
    };
    get(url, 0);
  });

export interface ArtworkOptions {
  fetcher?: ArtworkFetcher;
  timeoutMs?: number;
  maxBytes?: number;
  log?: (message: string) => void;
}

/**
 * Pictures that templates link to, downloaded once into the data folder and served by the panel itself. A browser never
 * contacts the publisher, and a picture that has gone missing or never arrived just leaves the card with its gradient.
 */
export class ArtworkCache {
  private readonly dir: string;
  private readonly fetcher: ArtworkFetcher;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly log: (message: string) => void;
  private readonly files = new Map<string, { file: string; type: ArtworkType }>();
  private running: Promise<void> | null = null;

  constructor(dataDir: string, opts: ArtworkOptions = {}) {
    this.dir = path.join(dataDir, "artwork");
    this.fetcher = opts.fetcher ?? httpsFetcher;
    this.timeoutMs = opts.timeoutMs ?? ARTWORK_TIMEOUT_MS;
    this.maxBytes = opts.maxBytes ?? ARTWORK_MAX_BYTES;
    this.log = opts.log ?? (() => undefined);
  }

  /** The cached picture for a template, if it has arrived. */
  get(templateId: string): { file: string; type: ArtworkType } | undefined {
    return this.files.get(templateId);
  }

  /** Cache file names are `<template id>-<hash of the link>.<ext>`, so a template that changes its link fetches again. */
  private nameBase(id: string, url: string) {
    return `${id}-${createHash("sha256").update(url).digest("hex").slice(0, 12)}`;
  }

  /** Picks up pictures kept from an earlier run (so they work offline) and removes the ones no template links to any more. */
  load(templates: GameTemplate[]): void {
    this.files.clear();
    let names: string[] = [];
    try {
      names = readdirSync(this.dir);
    } catch {
      return;
    }
    const wanted = new Map<string, string>();
    for (const t of templates) if (t.artwork && isArtworkUrl(t.artwork)) wanted.set(this.nameBase(t.id, t.artwork), t.id);
    for (const name of names) {
      const m = /^(.+)\.(png|jpg|webp)$/.exec(name);
      const id = m && wanted.get(m[1]);
      if (m && id) this.files.set(id, { file: path.join(this.dir, name), type: TYPE_OF_EXT[m[2]] });
      else rmSync(path.join(this.dir, name), { force: true });
    }
  }

  /** Downloads whatever is linked and not cached yet. One download failing never stops the others; calling it again retries only the missing ones. */
  refresh(templates: GameTemplate[]): Promise<void> {
    this.running ??= this.fetchMissing(templates).finally(() => (this.running = null));
    return this.running;
  }

  private async fetchMissing(templates: GameTemplate[]) {
    const todo = templates.filter((t): t is GameTemplate & { artwork: string } => Boolean(t.artwork && isArtworkUrl(t.artwork)) && !this.files.has(t.id));
    await Promise.all(
      todo.map(async (t) => {
        try {
          const { body } = await this.fetcher(t.artwork, { timeoutMs: this.timeoutMs, maxBytes: this.maxBytes });
          if (body.length > this.maxBytes) throw new Error("picture is too large");
          const type = sniffImage(body);
          if (!type) throw new Error("not a png, jpg or webp picture");
          mkdirSync(this.dir, { recursive: true });
          const file = path.join(this.dir, `${this.nameBase(t.id, t.artwork)}.${EXT[type]}`);
          writeFileSync(`${file}.part`, body);
          renameSync(`${file}.part`, file);
          this.files.set(t.id, { file, type });
        } catch (e) {
          this.log(`artwork for ${t.id} not fetched: ${(e as Error).message}`);
        }
      }),
    );
  }
}
