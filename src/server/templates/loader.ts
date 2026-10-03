import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { templateSchema, type GameTemplate } from "../../shared/template.js";

export function parseTemplate(source: string, label = "template"): GameTemplate {
  const result = templateSchema.safeParse(parse(source));
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
    throw new Error(`Invalid ${label}:\n${issues}`);
  }
  return result.data;
}

export function loadTemplates(dir: string): GameTemplate[] {
  const files = readdirSync(dir).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml")).sort();
  const templates = files.map((f) => parseTemplate(readFileSync(path.join(dir, f), "utf8"), f));
  const ids = new Set<string>();
  for (const t of templates) {
    if (ids.has(t.id)) throw new Error(`Duplicate template id "${t.id}"`);
    ids.add(t.id);
  }
  return templates;
}
