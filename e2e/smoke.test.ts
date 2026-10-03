/**
 * Browser smoke test: the built web app against the real API, with a fake Docker and router behind it.
 * Needs `npm run build:web` first and a Chromium (Playwright's, or one named by CHROMIUM_PATH).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { chromium, type Browser, type Page } from "playwright";
import { buildApp } from "../src/server/app.js";
import { loadConfig } from "../src/server/config.js";
import { openDb } from "../src/server/db/index.js";
import { DnsSettings } from "../src/server/dns/settings.js";
import { UpdateChecker } from "../src/server/updates.js";
import { Notifier } from "../src/server/notifications/notifier.js";
import { ServerService } from "../src/server/servers/service.js";
import { loadTemplates } from "../src/server/templates/loader.js";
import { FakeConnectivity, FakeDocker } from "../test/helpers/fakes.js";

const PASSWORD = "correct horse battery";
let browser: Browser;
let page: Page;
let url: string;
let close: () => Promise<void>;
const pageErrors: string[] = [];
const shots = process.env.SMOKE_SHOTS;

beforeAll(async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "gl-e2e-"));
  const config = loadConfig({ SESSION_SECRET: "x".repeat(40), DATA_DIR: dir, GAMESERVERS_DIR: path.join(dir, "games"), HOST_LAN_IP: "192.168.1.50" });
  const { db } = openDb(":memory:");
  const templates = loadTemplates(path.resolve("templates"));
  const docker = new FakeDocker();
  const service = new ServerService({ config, db, templates, docker, connectivity: new FakeConnectivity(), hostPorts: () => new Set(), background: false, stableMs: 0, tagLister: async () => ["v2.8.0", "v2.9.0", "latest"], portProbe: { name: "fake-checker", check: async () => ({ state: "open", detail: "Connected from 3 of 3 locations" }) }, queryPlayers: async () => ({ online: 2, max: 32 }) });
  // A newer release is "out there", so the update notice has something to show.
  const release = { tag_name: "v0.2.0", name: "v0.2.0", html_url: "https://github.com/LordMerc/self-hosted-game-labs/releases/tag/v0.2.0" };
  const updates = new UpdateChecker(db, { current: "0.1.0", envEnabled: true, fetchFn: (async () => new Response(JSON.stringify(release))) as unknown as typeof fetch });
  await updates.checkIfDue();
  const app = buildApp({ config, db, templates, service, docker, dnsSettings: new DnsSettings(db, config), updates, notifier: new Notifier(db, config), webRoot: path.resolve("dist/web") });
  await app.listen({ port: 0, host: "127.0.0.1" });
  url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  close = () => app.close();
  // A world to back up, so the Backups dialog has something to work on.
  const mkWorld = (slug: string) => {
    mkdirSync(path.join(dir, "games", slug, "Saved"), { recursive: true });
    writeFileSync(path.join(dir, "games", slug, "Saved", "world.sav"), "world");
  };
  mkWorld("palworld");

  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ["--no-sandbox"] });
  page = await browser.newPage({ viewport: { width: 1300, height: 1100 } });
  page.setDefaultTimeout(8000); // a step that cannot find its element fails with its own message, not the whole test timing out
  page.on("dialog", (d) => void d.accept()); // confirm() questions: always say yes
  page.on("pageerror", (e) => pageErrors.push(e.message));
  // The port clash in the custom-image test is a 409 on purpose; anything else the browser reports is a bug.
  page.on("console", (m) => m.type() === "error" && !m.text().includes("409") && pageErrors.push(`console: ${m.text()}`));
});

afterAll(async () => {
  await browser?.close();
  await close?.();
});

const shot = (name: string) => (shots ? page.screenshot({ path: path.join(shots, `${name}.png`) }) : undefined);
const row = (name: string) => page.locator("tbody tr", { hasText: name });
/** Opens a row's "..." menu and picks an item. */
/** Picks a template from the "View more" dialog, which holds every game and the custom image. */
const pick = async (name: string) => {
  await page.getByRole("button", { name: "View more" }).click();
  await page.getByRole("dialog", { name: "All games" }).getByRole("button", { name }).click();
};
const choose = async (name: string, item: string) => {
  await row(name).getByRole("button", { name: /More actions/ }).click();
  await page.getByRole("menuitem", { name: item }).click();
};

describe("the panel in a browser", () => {
  it("asks for an admin password on first run, then shows the empty server list and the templates", async () => {
    await page.goto(url);
    await page.getByRole("heading", { name: "Set an admin password" }).waitFor();
    await page.getByPlaceholder("Password").fill(PASSWORD);
    await page.keyboard.press("Enter");
    await page.getByRole("heading", { name: "Game servers" }).waitFor();
    // A few templates sit on the page; "View more" opens a dialog with all of them and the custom image, and Close puts it away.
    expect(await page.locator(".deploy > .templates .template-card").count()).toBe(4);
    await page.getByRole("button", { name: "View more" }).click();
    const all = page.getByRole("dialog", { name: "All games" });
    for (const t of ["Palworld", "Minecraft (Java)", "Valheim", "Satisfactory", "Terraria", "Custom Docker image"]) {
      await all.getByRole("button", { name: t }).waitFor();
    }
    await page.mouse.click(5, 5); // clicking outside does not close it
    await all.waitFor();
    await all.getByRole("button", { name: "Close" }).click();
    await all.waitFor({ state: "detached" });
    await shot("1-empty");
  });

  it("deploys a template from the form and shows the server running", async () => {
    await pick("Palworld");
    await page.getByRole("heading", { name: "Deploy Palworld" }).waitFor();
    await page.getByRole("button", { name: "Deploy", exact: true }).click();
    await row("Palworld").getByText("Running").waitFor();
    await shot("2-running");
  });

  it("makes the user choose the Minecraft EULA, and shows what the choices are", async () => {
    await pick("Minecraft (Java)");
    const eula = page.getByLabel(/Accept the Minecraft EULA/);
    expect(await eula.locator("option").allTextContents()).toEqual(["Choose…", "TRUE"]);
    await page.getByRole("button", { name: "Deploy", exact: true }).click();
    // The browser stops the form until the required choice is made, so nothing was created.
    expect(await row("Minecraft").count()).toBe(0);
    await eula.selectOption("TRUE");
    await page.getByRole("button", { name: "Deploy", exact: true }).click();
    // The fake Docker never opens the game's port, so the server stays in Starting, as a slow first start does.
    await row("Minecraft").getByText(/Running|Starting/).waitFor();
  });

  it("sets up a custom Docker image, and says so when a port is taken", async () => {
    await pick("Custom Docker image");
    await page.getByLabel("Server name").fill("Bedrock");
    await page.getByLabel("Docker image").fill("itzg/minecraft-bedrock-server:latest");
    await page.getByLabel("Ports the game uses").fill("25565/tcp");
    await page.getByRole("button", { name: "Deploy", exact: true }).click();
    await page.getByText(/already in use/).waitFor(); // Minecraft above holds 25565/tcp
    await page.getByLabel("Ports the game uses").fill("19132/udp");
    await page.getByRole("button", { name: "Deploy", exact: true }).click();
    await row("Bedrock").getByText(/Running|Starting/).waitFor();
    await shot("3-custom");
  });

  it("warns when a memory limit is below what the game needs, shows the limit, and changes it from the server page", async () => {
    await pick("Satisfactory");
    await page.getByRole("spinbutton", { name: /Memory limit/ }).fill("4");
    await page.getByText(/needs about 8 GB of memory, so a 4 GB limit/).waitFor();
    await page.getByRole("button", { name: "Deploy", exact: true }).click();
    await row("Satisfactory").getByText("Limit 4 GB").waitFor();
    await page.getByRole("button", { name: "Satisfactory", exact: true }).first().click();
    await page.getByRole("spinbutton", { name: /CPU limit/ }).fill("2");
    await page.getByRole("spinbutton", { name: /Memory limit/ }).fill("8");
    await page.locator("form.settings-card").getByRole("button", { name: "Save and restart" }).click();
    await page.getByText(/restarting to apply the changes/).waitFor();
    await page.locator("dl.facts").getByText("2 cores · 8 GB").waitFor();
    await shot("3a-limits");
    await page.getByRole("link", { name: "Game servers" }).click();
    await row("Satisfactory").getByText("Limit 2 cores · 8 GB").waitFor();
  });

  it("checks a public server's port from outside and shows the answer", async () => {
    await choose("Minecraft", "Make public");
    await row("Minecraft").getByText("Untested").waitFor();
    await page.getByText("hasn't been tested from outside").waitFor(); // Network health flags it too
    await row("Minecraft").getByRole("button", { name: /^Test / }).click();
    await row("Minecraft").getByText("Reachable").waitFor();
    await page.getByText(/reachable from the internet/).waitFor();
    // The whole-network check lists each port it tried and names who was asked.
    await page.getByRole("button", { name: "Check again" }).click();
    await page.getByText("Connected from 3 of 3 locations").waitFor();
    await page.getByText(/sends your public IP and the port number to fake-checker/).waitFor();
    await shot("3b-port-check");
  });

  it("opens a server's page, runs a console command and renames the server", async () => {
    await page.getByRole("button", { name: "Palworld", exact: true }).first().click();
    await page.getByLabel("Console command").fill("ShowPlayers");
    await page.getByRole("button", { name: "Run" }).click();
    await page.getByText(/ran rcon-cli/).waitFor();
    await page.getByLabel("Name in the panel").fill("Palworld Prime");
    await page.locator("form.settings-card").getByRole("button", { name: "Save", exact: true }).click();
    await page.getByText("Saved.").waitFor();
    await shot("4-server-page");
    await page.getByRole("link", { name: "Game servers" }).click();
    await row("Palworld Prime").waitFor();
  });

  it("sets a daily restart, finds and applies an update, and moves the game port", async () => {
    await page.getByRole("button", { name: "Palworld Prime", exact: true }).first().click();
    await page.getByLabel("Restart every day at").check();
    await page.getByLabel("Restart time").fill("03:30");
    await page.locator("form.settings-card").getByRole("button", { name: "Save", exact: true }).click();
    await page.getByText("Saved.").first().waitFor();
    await page.getByRole("button", { name: "Check for update" }).click();
    await page.locator("p.update-note", { hasText: /Version v2\.9\.0 is out/ }).waitFor();
    await shot("4b-update");
    await page.getByRole("button", { name: "Update to v2.9.0" }).click();
    await page.getByText(/Updating\. A backup was made/).waitFor();
    await page.locator("span.mono", { hasText: "palworld-server-docker:v2.9.0" }).waitFor();
    await page.getByLabel("Game port").fill("9000");
    await page.getByRole("button", { name: "Change port" }).click();
    await page.getByText(/restarting on the new port/).waitFor();
    await page.getByText("9000", { exact: false }).first().waitFor();
    await page.getByRole("link", { name: "Game servers" }).click();
    await row("Palworld Prime").waitFor();
  });

  it("has a row menu that stays on screen, closes on Escape and outside clicks, and names the icon buttons", async () => {
    const more = row("Bedrock").getByRole("button", { name: /More actions/ });
    await more.click();
    const menu = page.getByRole("menu");
    await menu.waitFor();
    const box = (await menu.boundingBox())!;
    const view = page.viewportSize()!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(view.width);
    expect(box.y + box.height).toBeLessThanOrEqual(view.height);
    await shot("3c-row-menu");
    await page.keyboard.press("Escape");
    await menu.waitFor({ state: "detached" });
    await more.click();
    await menu.waitFor();
    await page.getByRole("heading", { name: "Game servers" }).click();
    await menu.waitFor({ state: "detached" });
    // The primary button says what it does, in words and to screen readers.
    await row("Bedrock").getByRole("button", { name: "Stop Bedrock" }).waitFor();
    await row("Bedrock").getByRole("button", { name: "Logs for Bedrock" }).waitFor();
  });

  it("shows Stopped, then Starting again, and answers the \"/\" shortcut by focusing the search box", async () => {
    await row("Bedrock").getByRole("button", { name: "Stop Bedrock" }).click();
    await row("Bedrock").getByText("Stopped").waitFor();
    await row("Bedrock").getByRole("button", { name: "Start Bedrock" }).waitFor();
    await page.getByRole("tab", { name: /^Stopped/ }).click();
    expect(await row("Bedrock").count()).toBe(1);
    expect(await row("Minecraft").count()).toBe(0); // running servers are filtered out
    await page.getByRole("tab", { name: /^All/ }).click();
    await row("Bedrock").getByRole("button", { name: "Start Bedrock" }).click();
    await row("Bedrock").getByText(/Running|Starting/).waitFor();
    await page.getByRole("heading", { name: "Game servers" }).click();
    await page.keyboard.press("/");
    expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe("Search servers");
    await page.keyboard.press("Escape");
  });

  it("lays the dashboard out without sideways scrolling at laptop, tablet and phone widths", async () => {
    for (const [width, height] of [[1440, 900], [1024, 800], [390, 844]] as const) {
      await page.setViewportSize({ width, height });
      await page.waitForTimeout(150);
      const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      const culprits = wide <= 0 ? [] : await page.evaluate(() => [...document.querySelectorAll("body *")].filter((e) => e.getBoundingClientRect().right > window.innerWidth + 1).slice(0, 5).map((e) => `${e.tagName}.${e.className}`));
      expect(wide, `${width}px wide; too wide: ${culprits.join(", ")}`).toBeLessThanOrEqual(0);
      await shot(`3d-${width}`);
    }
    await page.setViewportSize({ width: 1300, height: 1100 });
  });

  it("backs up a server, deletes it, and sets it up again from the Backups page", async () => {
    await choose("Palworld Prime", "Backups…");
    await page.getByRole("button", { name: "Back up now" }).click();
    await page.locator(".backup-list li").first().waitFor();
    await page.getByRole("button", { name: "Close" }).click();
    await choose("Palworld Prime", "Delete server…");
    await page.locator("tbody tr", { hasText: "Palworld Prime" }).waitFor({ state: "detached" });

    await page.getByRole("link", { name: "Backups" }).click();
    await page.getByRole("heading", { name: "Backups", exact: true }).waitFor();
    await page.getByText("Server deleted").waitFor();
    await shot("5-backups");
    await page.getByRole("button", { name: "Set up again" }).first().click();
    await page.getByRole("heading", { name: /Set up Palworld Prime again/ }).waitFor();
    await page.locator("form.dialog").getByRole("button", { name: "Set up again", exact: true }).click();
    await page.getByRole("heading", { name: "Game servers" }).waitFor();
    await row("Palworld Prime").getByText("Running").waitFor();
  });

  it("shows a new-version notice that can be closed, and an Updates section in Settings with an off switch", async () => {
    await page.reload();
    const banner = page.getByRole("status").filter({ hasText: "Version 0.2.0 is available" });
    await banner.waitFor();
    expect(await banner.getByRole("link", { name: "See what's new" }).getAttribute("href")).toBe("https://github.com/LordMerc/self-hosted-game-labs/releases/tag/v0.2.0");
    await shot("6-update-banner");
    await banner.getByRole("button", { name: "Dismiss" }).click();
    await banner.waitFor({ state: "detached" });
    await page.reload();
    await page.getByRole("heading", { name: "Game servers" }).waitFor();
    expect(await banner.count()).toBe(0); // stays closed for this version

    await page.getByRole("link", { name: "Settings", exact: true }).click();
    await page.getByRole("heading", { name: "Updates" }).waitFor();
    await page.getByText("Version 0.2.0 is available.").waitFor();
    await shot("7-updates-settings");
    await page.getByLabel("Check for new versions once a day").click();
    await page.getByText("Update checks are off.").waitFor();
    await page.getByLabel("Check for new versions once a day").click();
    await page.getByText("Version 0.2.0 is available.").waitFor();
  });

  it("saves a webhook in Settings, sends a test message to it and keeps the address hidden", async () => {
    const received: { event?: string; title?: string }[] = [];
    const hook = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => (received.push(JSON.parse(body)), res.writeHead(204).end()));
    });
    await new Promise<void>((r) => hook.listen(0, "127.0.0.1", r));
    const hookUrl = `http://127.0.0.1:${(hook.address() as AddressInfo).port}/hooks/games`;
    try {
      await page.getByRole("link", { name: "Settings", exact: true }).click();
      await page.getByRole("heading", { name: "Notifications" }).waitFor();
      await page.getByPlaceholder(/discord.com\/api\/webhooks/).fill(hookUrl);
      await page.getByRole("button", { name: "Send test message" }).click();
      await page.getByText("Sent. Check your channel").waitFor();
      expect(received.map((r) => r.event)).toEqual(["test"]);
      await page.locator("form.notify-form").getByRole("button", { name: "Save", exact: true }).click();
      await page.getByText(/Sending to a webhook at/).waitFor();
      expect(await page.content()).not.toContain("/hooks/games");
      await page.getByLabel("A player leaves").check();
      await page.getByLabel("A server comes online").uncheck();
      await page.reload();
      await page.getByText(/Sending to a webhook at/).waitFor();
      expect(await page.getByLabel("A player leaves").isChecked()).toBe(true);
      expect(await page.getByLabel("A server comes online").isChecked()).toBe(false);
      await shot("6-notifications");
    } finally {
      hook.close();
    }
  });

  it("has no browser errors", () => {
    expect(pageErrors).toEqual([]);
  });
});
