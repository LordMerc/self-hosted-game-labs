import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { ManualProvider } from "./connectivity/manual.js";
import { echoPublicIp } from "./connectivity/provider.js";
import { UpnpProvider } from "./connectivity/upnp.js";
import { openDb } from "./db/index.js";
import { DnsSettings } from "./dns/settings.js";
import { RelayManager } from "./relay/manager.js";
import { Notifier } from "./notifications/notifier.js";
import { DockerodeDriver } from "./docker/driver.js";
import { ServerService } from "./servers/service.js";
import { detectLanIp } from "./lan-ip.js";
import { HostStats } from "./host-stats.js";
import { settingsPeakStore, StatsHistory } from "./history.js";
import { CheckHostProbe } from "./reachability.js";
import { ArtworkCache } from "./templates/artwork.js";
import { loadTemplates } from "./templates/loader.js";
import { runningVersion, UpdateChecker } from "./updates.js";

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
// Pictures that templates link to are fetched once into the data folder (never by the visitor's browser); until one arrives the card keeps its gradient.
const artwork = new ArtworkCache(config.DATA_DIR, { log: (m) => console.log(m) });
artwork.load(templates);
const docker = new DockerodeDriver();
const connectivity = config.CONNECTIVITY === "upnp" ? new UpnpProvider(undefined, () => echoPublicIp(config.IP_ECHO_URL), config.HOST_LAN_IP || undefined) : new ManualProvider(db, config.IP_ECHO_URL);
const dnsSettings = new DnsSettings(db, config);
const notifier = new Notifier(db, config);
const relay = new RelayManager(db, config, docker);

const service = new ServerService({ config, db, templates, docker, connectivity, dnsProvider: () => dnsSettings.current(), notifier, relay, portProbe: config.PORT_CHECK === "on" ? new CheckHostProbe() : null });
const hostStats = new HostStats([config.GAMESERVERS_DIR, config.DATA_DIR]);
hostStats.snapshot(); // first sample, so CPU and network rates exist by the time the page asks
const updates = new UpdateChecker(db, { current: runningVersion(config.APP_VERSION), envEnabled: config.UPDATE_CHECK === "on" });
const history = new StatsHistory({ store: settingsPeakStore(db) });
const app = buildApp({ config, db, templates, service, docker, dnsSettings, relay, notifier, hostStats, history, updates, artwork, webRoot: "dist/web" });

const RECONCILE_MS = 5 * 60 * 1000;
let reconciling = false;
const reconcile = async () => {
  if (reconciling) return;
  reconciling = true;
  try {
    const actions = await service.reconcile();
    if (actions.length > 0) console.log(`reconcile: ${actions.join("; ")}`);
    await relay.reconfigure(); // the agent container (managed mode) matches what the servers need
    await relay.refresh();
  } catch (e) {
    console.error("reconcile failed:", e);
  } finally {
    reconciling = false;
  }
};

await app.listen({ port: config.PANEL_PORT, host: config.PANEL_HOST });
console.log(
  `Self Hosted Game Labs on ${config.PANEL_HOST}:${config.PANEL_PORT} | ${templates.length} templates | connectivity=${connectivity.kind} | dns=${dnsSettings.status().configured ? "cloudflare" : "off"}`,
);

const scheduledBackups = async () => {
  try {
    const done = await service.runScheduledBackups();
    if (done.length > 0) console.log(`scheduled backups: ${done.join("; ")}`);
  } catch (e) {
    console.error("scheduled backups failed:", e);
  }
};

let caring = false;
const scheduledCare = async () => {
  if (caring) return;
  caring = true;
  try {
    const done = await service.runScheduledCare();
    if (done.length > 0) console.log(`scheduled care: ${done.join("; ")}`);
  } catch (e) {
    console.error("scheduled care failed:", e);
  } finally {
    caring = false;
  }
};

// Notice crashes and player joins/leaves within about half a minute, whether or not anyone has the page open.
let watching = false;
const watch = async () => {
  if (watching) return;
  watching = true;
  try {
    await service.watch();
  } catch (e) {
    console.error("watch failed:", e);
  } finally {
    watching = false;
  }
};

// A point for the dashboard's small charts every 20 seconds, whether or not anyone has the page open.
let sampling = false;
const sample = async () => {
  if (sampling) return;
  sampling = true;
  try {
    history.record(hostStats.snapshot(), await service.usage());
  } catch (e) {
    console.error("stats sample failed:", e);
  } finally {
    sampling = false;
  }
};

const fetchArtwork = () => artwork.refresh(templates).catch((e) => console.error("artwork fetch failed:", e));
setTimeout(fetchArtwork, 2000).unref();
setInterval(fetchArtwork, 60 * 60 * 1000).unref(); // retries only the pictures that have not arrived

setTimeout(reconcile, 3000);
setTimeout(sample, 5000).unref();
setInterval(sample, 20_000).unref();
setInterval(watch, 30_000).unref();
setTimeout(scheduledBackups, 60_000).unref();
setInterval(scheduledBackups, 10 * 60 * 1000).unref();
setInterval(reconcile, RECONCILE_MS).unref();
setInterval(scheduledCare, 60 * 1000).unref();

// Looks for a newer release at most once a day (the check itself decides whether one is due; this just asks hourly).
const checkForUpdates = () => updates.checkIfDue().catch(() => undefined);
setTimeout(checkForUpdates, 30_000).unref();
setInterval(checkForUpdates, 60 * 60 * 1000).unref();
