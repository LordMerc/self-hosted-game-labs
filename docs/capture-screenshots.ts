/**
 * Regenerates the screenshots in docs/images from the real web app, running against a fake Docker, router and DNS
 * with a few demo servers (no real containers, and the public IP is a documentation address, 203.0.113.7).
 *
 *   npm run build:web && npx tsx docs/capture-screenshots.ts
 *
 * Needs Chromium (Playwright's, or one named by CHROMIUM_PATH).
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { chromium, type Page } from "playwright";
import { buildApp } from "../src/server/app.js";
import { type HostStats, type HostSnapshot } from "../src/server/host-stats.js";
import { StatsHistory, type PeakStore } from "../src/server/history.js";
import { loadConfig } from "../src/server/config.js";
import { openDb } from "../src/server/db/index.js";
import { DnsSettings } from "../src/server/dns/settings.js";
import { ServerService } from "../src/server/servers/service.js";
import { loadTemplates } from "../src/server/templates/loader.js";
import { FakeConnectivity, FakeDns, FakeDocker } from "../test/helpers/fakes.js";

const out = path.resolve("docs/images");
mkdirSync(out, { recursive: true });

const dir = mkdtempSync(path.join(os.tmpdir(), "gl-shots-"));
const config = loadConfig({ SESSION_SECRET: "x".repeat(40), DATA_DIR: dir, GAMESERVERS_DIR: path.join(dir, "games"), HOST_LAN_IP: "192.168.1.50", PUBLIC_HOST: "play.example.com" });
const { db } = openDb(":memory:");
const templates = loadTemplates(path.resolve("templates"));
const docker = new FakeDocker();
const players: Record<number, number> = { 27015: 3, 25565: 5 };
const service = new ServerService({
  config, db, templates, docker, dns: new FakeDns(), connectivity: new FakeConnectivity(), hostPorts: () => new Set(), background: false, stableMs: 0,
  portProbe: { name: "check-host.net", check: async () => ({ state: "open", detail: "Connected from 3 of 3 locations" }) },
  queryPlayers: async (_h, port) => ({ online: players[port] ?? 0, max: port === 25565 ? 20 : 32 }),
});

// Host figures are made up too, so the numbers and charts look the same on every run (a real host would show its own).
const GB = 1000 ** 3;
const demoHost: HostSnapshot = { cpu: { percent: 8, cores: 8 }, memory: { usedBytes: 7.7 * GB, totalBytes: 16.7 * GB }, storage: { usedBytes: 27 * GB, totalBytes: 983 * GB }, network: { rxPerSec: 16_000, txPerSec: 24_000 }, uptimeSec: 23 * 86400 + 5 * 3600 };
const hostStats = { snapshot: () => demoHost } as unknown as HostStats;
let peak: string | null = null;
const peakStore: PeakStore = { load: () => peak, save: (v) => void (peak = v) };
const history = new StatsHistory({ store: peakStore });
for (let i = 0; i < 45; i++) {
  const wave = (n: number, k: number) => Math.max(0, Math.round(n + k * Math.sin(i / 3) + ((i * 37) % 7)));
  const online = i > 14 ? Math.min(9, Math.round(i / 5) + ((i * 5) % 3)) : 0;
  history.record(
    { ...demoHost, cpu: { percent: wave(8, 4), cores: 8 }, network: { rxPerSec: wave(14, 8) * 1000, txPerSec: wave(20, 6) * 1000 }, uptimeSec: demoHost.uptimeSec },
    { demo: { cpuPercent: null, memBytes: 0, players: { online, max: 40 } } },
  );
}
const app = buildApp({ config, db, templates, service, docker, dnsSettings: new DnsSettings(db, config), hostStats, history, webRoot: path.resolve("dist/web") });
await app.listen({ port: 0, host: "127.0.0.1" });
const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

for (const slug of ["palworld", "runescape-dragonwilds", "minecraft-java"]) {
  mkdirSync(path.join(dir, "games", slug, "Saved"), { recursive: true });
  writeFileSync(path.join(dir, "games", slug, "Saved", "world.sav"), randomBytes(24 * 1024 * 1024));
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ["--no-sandbox"] });
const page: Page = await browser.newPage({ viewport: { width: 1900, height: 1080 }, deviceScaleFactor: 1 });
const row = (name: string) => page.locator("tbody tr", { hasText: name });
/** Opens a row's "..." menu and picks an item. */
const choose = async (name: string, item: string) => {
  await row(name).getByRole("button", { name: /More actions/ }).click();
  await page.getByRole("menuitem", { name: item }).click();
};
const deploy = async () => page.getByRole("button", { name: "Deploy", exact: true }).click();
const shot = (name: string, opts: { fullPage?: boolean } = {}) => page.screenshot({ path: path.join(out, `${name}.png`), ...opts });

await page.goto(url);
await page.getByPlaceholder("Password").fill("correct horse battery");
await page.keyboard.press("Enter");
await page.getByRole("heading", { name: "Game servers" }).waitFor();

// Palworld, Dragonwilds and Minecraft, all public; Valheim private.
await page.getByRole("button", { name: "Palworld" }).first().click();
await deploy();
await row("Palworld").getByText("Running").waitFor();

await page.getByRole("button", { name: "RuneScape: Dragonwilds" }).first().click();
await page.getByLabel("Your Dragonwilds Player ID").fill("DEMO-PLAYER-ID");
await page.getByLabel("World name").fill("Merc Sanctum");
await deploy();
await row("Dragonwilds").getByText(/Running|Starting/).waitFor();

await page.getByRole("button", { name: "Minecraft (Java)" }).first().click();
await page.getByLabel(/Accept the Minecraft EULA/).selectOption("TRUE");
await deploy();
await row("Minecraft").getByText(/Running|Starting/).waitFor();

await page.getByRole("button", { name: "Valheim" }).first().click();
await page.getByLabel(/Server password/).fill("demo-password");
await deploy();
await row("Valheim").getByText(/Running|Starting/).waitFor();

// Palworld and Minecraft go public; Dragonwilds stays untested so the Access column shows both states. Valheim is stopped.
for (const n of ["Palworld", "RuneScape", "Minecraft"]) await choose(n, "Make public");
await row("Valheim").getByRole("button", { name: /^Stop/ }).click();
await row("Valheim").getByText("Stopped").waitFor();
await row("Palworld").getByRole("button", { name: /^Test / }).click();
await row("Palworld").getByText("Forwarded").waitFor();
await row("Minecraft").getByRole("button", { name: /^Test / }).click();
await row("Minecraft").getByText("Reachable").waitFor();
await page.waitForTimeout(1500);
await page.reload();
await page.getByRole("heading", { name: "Game servers" }).waitFor();
await page.waitForTimeout(2500);
await shot("dashboard");

// The "..." menu, open on the first row.
await row("Palworld").getByRole("button", { name: /More actions/ }).click();
await page.getByRole("menu").waitFor();
await shot("row-menu");
await page.keyboard.press("Escape");

// A laptop-sized window: the Network health panel moves under the table (on a phone each server becomes a card).
await page.setViewportSize({ width: 1440, height: 900 });
await page.waitForTimeout(500);
await shot("dashboard-1440", { fullPage: true });

await page.setViewportSize({ width: 1900, height: 2200 });
await page.waitForTimeout(500);
await page.getByRole("button", { name: "Run check" }).click();
await page.getByText("Connected from 3 of 3 locations").first().waitFor();
const box = (await page.locator("aside.network").boundingBox())!;
await page.screenshot({ path: path.join(out, "network-panel.png"), clip: { x: box.x - 8, y: box.y - 8, width: box.width + 16, height: box.height + 16 } });
await page.setViewportSize({ width: 1900, height: 1080 });

// A server's own page (narrower window, so the page is not mostly empty space).
await page.setViewportSize({ width: 1400, height: 1250 });
await page.getByRole("button", { name: "Palworld", exact: true }).first().click();
await page.getByLabel("Console command").waitFor();
await page.getByLabel("Console command").fill("ShowPlayers");
await page.getByRole("button", { name: "Run" }).click();
await page.getByText(/ran rcon-cli/).waitFor();
await page.waitForTimeout(500);
await page.evaluate(() => window.scrollTo(0, 0));
await shot("server-page");
await page.getByRole("link", { name: "Game servers" }).click();

// Back up the worlds, then delete Minecraft so the Backups tab shows a deleted server that can be set up again.
page.on("dialog", (d) => void d.accept());
for (const n of ["Palworld", "RuneScape", "Minecraft"]) {
  await choose(n, "Backups…");
  await page.getByRole("button", { name: "Back up now" }).click();
  await page.locator(".backup-list li").first().waitFor();
  await page.getByRole("button", { name: "Close" }).click();
}
await choose("Minecraft", "Delete server…");
await page.locator("tbody tr", { hasText: "Minecraft" }).waitFor({ state: "detached" });
await page.getByRole("link", { name: "Backups" }).click();
await page.getByRole("heading", { name: "Backups", exact: true }).waitFor();
await page.getByText("Server deleted").waitFor();
await shot("backups");

await browser.close();
await app.close();
console.log(`Screenshots written to ${out}`);
