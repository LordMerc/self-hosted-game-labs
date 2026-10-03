import path from "node:path";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { ManualProvider } from "./connectivity/manual.js";
import { UpnpProvider } from "./connectivity/upnp.js";
import { openDb } from "./db/index.js";
import { CloudflareClient } from "./dns/cloudflare.js";
import { DockerodeDriver } from "./docker/driver.js";
import { ServerService } from "./servers/service.js";
import { loadTemplates } from "./templates/loader.js";

const config = loadConfig();
const { db } = openDb(path.join(config.DATA_DIR, "panel.db"));
const templates = loadTemplates(config.TEMPLATES_DIR);
const docker = new DockerodeDriver();
const connectivity = config.CONNECTIVITY === "upnp" ? new UpnpProvider() : new ManualProvider(db, config.IP_ECHO_URL);
const dns = config.CF_API_TOKEN && config.CF_ZONE ? new CloudflareClient(config.CF_API_TOKEN, config.CF_ZONE) : undefined;

const service = new ServerService({ config, db, templates, docker, connectivity, dns });
const app = buildApp({ config, db, templates, service, docker, webRoot: "dist/web" });

await app.listen({ port: config.PANEL_PORT, host: "0.0.0.0" });
console.log(
  `Self Hosted Game Labs on :${config.PANEL_PORT} | ${templates.length} templates | connectivity=${connectivity.kind} | dns=${dns ? "cloudflare" : "off"}`,
);
