import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { ManualProvider } from "./connectivity/manual.js";
import { UpnpProvider } from "./connectivity/upnp.js";
import { openDb } from "./db/index.js";
import { DnsSettings } from "./dns/settings.js";
import { DockerodeDriver } from "./docker/driver.js";
import { ServerService } from "./servers/service.js";
import { detectLanIp } from "./lan-ip.js";
import { loadTemplates } from "./templates/loader.js";

/** Sessions need a stable secret. Use SESSION_SECRET if given, otherwise generate one once and keep it in the data dir. */
function sessionSecret(): string | undefined {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const dataDir = process.env.DATA_DIR ?? "/data";
  const file = path.join(dataDir, "session-secret");
  if (!existsSync(file)) {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(file, randomBytes(32).toString("hex"), { mode: 0o600 });
  }
  return readFileSync(file, "utf8").trim();
}

const config = loadConfig({ ...process.env, SESSION_SECRET: sessionSecret() });
config.HOST_LAN_IP ||= detectLanIp();
const { db } = openDb(path.join(config.DATA_DIR, "panel.db"));
const templates = loadTemplates(config.TEMPLATES_DIR);
const docker = new DockerodeDriver();
const connectivity = config.CONNECTIVITY === "upnp" ? new UpnpProvider() : new ManualProvider(db, config.IP_ECHO_URL);
const dnsSettings = new DnsSettings(db, config);

const service = new ServerService({ config, db, templates, docker, connectivity, dnsProvider: () => dnsSettings.current() });
const app = buildApp({ config, db, templates, service, docker, dnsSettings, webRoot: "dist/web" });

const RECONCILE_MS = 5 * 60 * 1000;
let reconciling = false;
const reconcile = async () => {
  if (reconciling) return;
  reconciling = true;
  try {
    const actions = await service.reconcile();
    if (actions.length > 0) console.log(`reconcile: ${actions.join("; ")}`);
  } catch (e) {
    console.error("reconcile failed:", e);
  } finally {
    reconciling = false;
  }
};

await app.listen({ port: config.PANEL_PORT, host: "0.0.0.0" });
console.log(
  `Self Hosted Game Labs on :${config.PANEL_PORT} | ${templates.length} templates | connectivity=${connectivity.kind} | dns=${dnsSettings.status().configured ? "cloudflare" : "off"}`,
);

setTimeout(reconcile, 3000);
setInterval(reconcile, RECONCILE_MS).unref();
