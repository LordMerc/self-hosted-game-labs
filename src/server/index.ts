import path from "node:path";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { openDb } from "./db/index.js";
import { loadTemplates } from "./templates/loader.js";

const config = loadConfig();
const { db } = openDb(path.join(config.DATA_DIR, "panel.db"));
const templates = loadTemplates(config.TEMPLATES_DIR);
const app = buildApp({ config, db, templates, webRoot: "dist/web" });

await app.listen({ port: config.PANEL_PORT, host: "0.0.0.0" });
console.log(`Self Hosted Game Labs listening on :${config.PANEL_PORT} (${templates.length} templates loaded)`);
