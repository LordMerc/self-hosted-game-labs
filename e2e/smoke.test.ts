/**
 * Browser smoke test: the built web app against the real API, with a fake Docker and router behind it.
 * Needs `npm run build:web` first and a Chromium (Playwright's, or one named by CHROMIUM_PATH).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { chromium, type Browser, type Page } from "playwright";
import { buildApp } from "../src/server/app.js";
import { loadConfig } from "../src/server/config.js";
import { openDb } from "../src/server/db/index.js";
import { DnsSettings } from "../src/server/dns/settings.js";
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
  const service = new ServerService({ config, db, templates, docker, connectivity: new FakeConnectivity(), hostPorts: () => new Set(), background: false, stableMs: 0, portProbe: { name: "fake-checker", check: async () => ({ state: "open", detail: "Connected from 3 of 3 locations" }) }, queryPlayers: async () => ({ online: 2, max: 32 }) });
  const app = buildApp({ config, db, templates, service, docker, dnsSettings: new DnsSettings(db, config), webRoot: path.resolve("dist/web") });
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

describe("the panel in a browser", () => {
  it("asks for an admin password on first run, then shows the empty server list and the templates", async () => {
    await page.goto(url);
    await page.getByRole("heading", { name: "Set an admin password" }).waitFor();
    await page.getByPlaceholder("Password").fill(PASSWORD);
    await page.keyboard.press("Enter");
    await page.getByRole("heading", { name: "Game servers" }).waitFor();
    for (const t of ["Palworld", "Minecraft (Java)", "Valheim", "Satisfactory", "Terraria", "Custom Docker image"]) {
      await page.getByRole("button", { name: t }).waitFor();
    }
    await shot("1-empty");
  });

  it("deploys a template from the form and shows the server running", async () => {
    await page.getByRole("button", { name: "Palworld" }).first().click();
    await page.getByRole("heading", { name: "Deploy Palworld" }).waitFor();
    await page.getByRole("button", { name: "Deploy", exact: true }).click();
    await row("Palworld").getByText("Running").waitFor();
    await shot("2-running");
  });

  it("makes the user choose the Minecraft EULA, and shows what the choices are", async () => {
    await page.getByRole("button", { name: "Minecraft (Java)" }).click();
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
    await page.getByRole("button", { name: "Custom Docker image" }).click();
    await page.getByLabel("Server name").fill("Bedrock");
    await page.getByLabel("Docker image").fill("itzg/minecraft-bedrock-server:latest");
    await page.getByLabel("Ports the game uses").fill("25565/tcp");
    await page.getByRole("button", { name: "Deploy", exact: true }).click();
    await page.getByText(/already in use/).waitFor(); // Minecraft above holds 25565/tcp
    await page.getByLabel("Ports the game uses").fill("19132/udp");
    await page.getByRole("button", { name: "Deploy", exact: true }).click();
    await row("Bedrock").getByText("Running").waitFor();
    await shot("3-custom");
  });

  it("warns when a memory limit is below what the game needs, shows the limit, and changes it from the server page", async () => {
    await page.getByRole("button", { name: "Satisfactory" }).click();
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
    await row("Minecraft").getByRole("button", { name: "Public" }).click();
    await page.getByRole("button", { name: "Run" }).first().waitFor();
    await page.getByRole("button", { name: "Run", exact: true }).first().click();
    await page.getByText("Connected from 3 of 3 locations").waitFor();
    await page.getByText("via fake-checker").waitFor();
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

  it("backs up a server, deletes it, and sets it up again from the Backups page", async () => {
    page.on("dialog", (d) => void d.accept());
    await row("Palworld Prime").getByRole("button", { name: "Backups" }).click();
    await page.getByRole("button", { name: "Back up now" }).click();
    await page.locator(".backup-list li").first().waitFor();
    await page.getByRole("button", { name: "Close" }).click();
    await row("Palworld Prime").getByRole("button", { name: "Delete" }).click();
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

  it("has no browser errors", () => {
    expect(pageErrors).toEqual([]);
  });
});
