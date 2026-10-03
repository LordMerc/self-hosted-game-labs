import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ArtworkCache, isPublicAddress, sniffImage, type ArtworkFetcher } from "../src/server/templates/artwork.js";
import { parseTemplate } from "../src/server/templates/loader.js";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 2)]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), Buffer.alloc(16)]);

const tpl = (id: string, artwork?: string) =>
  parseTemplate(`id: ${id}\nname: ${id}\nimage: example/${id}:1\n${artwork ? `artwork: ${artwork}\n` : ""}ports:\n  - { name: game, default: 7777, protocol: udp }\n`);
const tmp = () => mkdtempSync(path.join(os.tmpdir(), "gl-artwork-"));

describe("sniffImage", () => {
  it("knows png, jpeg and webp by their first bytes and nothing else", () => {
    expect(sniffImage(PNG)).toBe("image/png");
    expect(sniffImage(JPEG)).toBe("image/jpeg");
    expect(sniffImage(WEBP)).toBe("image/webp");
    expect(sniffImage(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
    expect(sniffImage(Buffer.from("<html>not found</html>"))).toBeNull();
    expect(sniffImage(Buffer.alloc(0))).toBeNull();
  });
});

describe("isPublicAddress", () => {
  it("accepts public addresses and refuses loopback, private, link-local and similar ones", () => {
    for (const ok of ["8.8.8.8", "1.1.1.1", "151.101.1.1", "2606:4700:4700::1111"]) expect(isPublicAddress(ok), ok).toBe(true);
    const no = ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "::", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "not an address"];
    for (const bad of no) expect(isPublicAddress(bad), bad).toBe(false);
  });
});

describe("ArtworkCache", () => {
  const limits = { timeoutMs: 1000, maxBytes: 1024 };

  it("downloads a linked picture once into the data folder and finds it again after a restart without the network", async () => {
    const dir = tmp();
    const calls: string[] = [];
    const fetcher: ArtworkFetcher = async (url) => (calls.push(url), { body: PNG });
    const templates = [tpl("a", "https://cdn.example.com/a.png"), tpl("b"), tpl("c", "artwork/local.png")];
    const cache = new ArtworkCache(dir, { fetcher, ...limits });
    cache.load(templates);
    await cache.refresh(templates);
    expect(calls).toEqual(["https://cdn.example.com/a.png"]);
    expect(cache.get("a")?.type).toBe("image/png");
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("c")).toBeUndefined();
    expect(readdirSync(path.join(dir, "artwork"))).toHaveLength(1);

    await cache.refresh(templates);
    expect(calls).toHaveLength(1);

    const later = new ArtworkCache(dir, { fetcher: async () => Promise.reject(new Error("offline")), ...limits });
    later.load(templates);
    expect(later.get("a")?.type).toBe("image/png");
    expect(existsSync(later.get("a")!.file)).toBe(true);
  });

  it("uses the real format of the file, not what the link's extension says", async () => {
    const cache = new ArtworkCache(tmp(), { fetcher: async () => ({ body: WEBP }), ...limits });
    const templates = [tpl("a", "https://cdn.example.com/a.png")];
    await cache.refresh(templates);
    expect(cache.get("a")).toMatchObject({ type: "image/webp" });
    expect(cache.get("a")!.file).toMatch(/\.webp$/);
  });

  it("keeps nothing and logs why when the download fails, is too big, or is not a picture", async () => {
    const dir = tmp();
    const logs: string[] = [];
    const answers: Record<string, () => Promise<{ body: Buffer }>> = {
      "https://cdn.example.com/down.png": async () => Promise.reject(new Error("timed out")),
      "https://cdn.example.com/big.png": async () => ({ body: Buffer.concat([PNG, Buffer.alloc(2000)]) }),
      "https://cdn.example.com/html.png": async () => ({ body: Buffer.from("<html>sign in</html>") }),
    };
    const cache = new ArtworkCache(dir, { fetcher: (url) => answers[url](), log: (m) => logs.push(m), ...limits });
    const templates = [tpl("down", "https://cdn.example.com/down.png"), tpl("big", "https://cdn.example.com/big.png"), tpl("html", "https://cdn.example.com/html.png")];
    await cache.refresh(templates);
    for (const id of ["down", "big", "html"]) expect(cache.get(id), id).toBeUndefined();
    expect(existsSync(path.join(dir, "artwork"))).toBe(false);
    expect(logs).toHaveLength(3);
    const all = logs.join("\n");
    expect(all).toMatch(/down not fetched: timed out/);
    expect(all).toMatch(/big not fetched: picture is too large/);
    expect(all).toMatch(/html not fetched: not a png/);
  });

  it("retries only what is missing the next time, and one failure does not stop the others", async () => {
    let up = false;
    const calls: string[] = [];
    const fetcher: ArtworkFetcher = async (url) => {
      calls.push(url);
      if (url.includes("flaky") && !up) throw new Error("503");
      return { body: JPEG };
    };
    const cache = new ArtworkCache(tmp(), { fetcher, ...limits });
    const templates = [tpl("flaky", "https://cdn.example.com/flaky.jpg"), tpl("fine", "https://cdn.example.com/fine.jpg")];
    await cache.refresh(templates);
    expect(cache.get("fine")).toBeDefined();
    expect(cache.get("flaky")).toBeUndefined();
    up = true;
    calls.length = 0;
    await cache.refresh(templates);
    expect(calls).toEqual(["https://cdn.example.com/flaky.jpg"]);
    expect(cache.get("flaky")).toBeDefined();
  });

  it("fetches again when a template changes its link, and cleans up pictures nothing links to", async () => {
    const dir = tmp();
    const fetcher: ArtworkFetcher = async () => ({ body: PNG });
    const first = new ArtworkCache(dir, { fetcher, ...limits });
    await first.refresh([tpl("a", "https://cdn.example.com/old.png")]);
    const oldFile = first.get("a")!.file;

    const calls: string[] = [];
    const next = new ArtworkCache(dir, { fetcher: async (u) => (calls.push(u), { body: PNG }), ...limits });
    const changed = [tpl("a", "https://cdn.example.com/new.png")];
    next.load(changed);
    expect(next.get("a")).toBeUndefined();
    expect(existsSync(oldFile)).toBe(false);
    await next.refresh(changed);
    expect(calls).toEqual(["https://cdn.example.com/new.png"]);

    const none = new ArtworkCache(dir, { fetcher, ...limits });
    none.load([tpl("a")]);
    expect(readdirSync(path.join(dir, "artwork"))).toHaveLength(0);
  });

  it("ignores stray files in the cache folder it does not recognise", () => {
    const dir = tmp();
    mkdirSync(path.join(dir, "artwork"));
    writeFileSync(path.join(dir, "artwork", "junk.png.part"), "x");
    const cache = new ArtworkCache(dir, { fetcher: async () => ({ body: PNG }), ...limits });
    cache.load([tpl("a", "https://cdn.example.com/a.png")]);
    expect(cache.get("a")).toBeUndefined();
  });
});
