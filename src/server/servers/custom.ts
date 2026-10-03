import { templateSchema, type GameTemplate } from "../../shared/template.js";
import { slugify } from "../slug.js";

export const CUSTOM_PREFIX = "custom-";

export const isCustomId = (id: string) => id.startsWith(CUSTOM_PREFIX);

export interface CustomInput {
  name: string;
  image: string;
  ports: { port: number; protocol: "tcp" | "udp" }[];
  env?: Record<string, string>;
  /** Folder inside the container where the game keeps its files; it is kept on the host so it survives the container. */
  dataPath?: string;
  /** `uid:gid` that should own the data folder, for images that run as a normal user and cannot write to a root-owned folder. */
  dataOwner?: string;
}

/** Why an input is not acceptable, in words for the person who typed it; null when it is fine. */
export function checkCustomInput(i: CustomInput): string | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9._\-/:@]*$/.test(i.image) || i.image.length > 200) return "That does not look like a Docker image name. Examples: itzg/minecraft-bedrock-server or ghcr.io/someone/game:latest";
  if (i.ports.length === 0 || i.ports.length > 20) return "Add at least one port (up to 20)";
  const seen = new Set<string>();
  for (const p of i.ports) {
    if (!Number.isInteger(p.port) || p.port < 1024 || p.port > 65535) return `Port ${p.port} is not valid (use 1024-65535)`;
    const k = `${p.port}/${p.protocol}`;
    if (seen.has(k)) return `Port ${k} is listed twice`;
    seen.add(k);
  }
  for (const [k, v] of Object.entries(i.env ?? {})) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(k)) return `${k} is not a valid setting name. Use capital letters, digits and underscores, like SERVER_NAME`;
    if (v.length > 1000) return `The value of ${k} is too long`;
  }
  if (i.dataPath && !/^(\/[A-Za-z0-9._-]+)+\/?$/.test(i.dataPath)) return "The data folder must be a path inside the container, like /data";
  if (i.dataOwner && !/^\d{1,10}:\d{1,10}$/.test(i.dataOwner)) return "The folder owner must look like 1000:1000 (user id and group id)";
  return null;
}

/**
 * A template for one user-supplied image. It goes through the same schema as the shipped templates, so it can never ask
 * for more than they can (no privileged mode, no host folders but its own data folder). The host port is the container
 * port, and there is no env var that tells the game to move, so these ports never shift: a clash is reported instead.
 */
export function buildCustomTemplate(i: CustomInput, taken: ReadonlySet<string>): GameTemplate {
  let id = `${CUSTOM_PREFIX}${slugify(i.name)}`;
  for (let n = 2; taken.has(id); n++) id = `${CUSTOM_PREFIX}${slugify(i.name)}-${n}`;
  const [uid, gid] = (i.dataOwner ?? "").split(":").map(Number);
  const owner = i.dataOwner ? { uid, gid } : undefined;
  return templateSchema.parse({
    id,
    name: "Custom image",
    image: i.image,
    ports: i.ports.map((p) => ({ name: `${p.protocol}-${p.port}`, default: p.port, protocol: p.protocol })),
    env: Object.fromEntries(
      Object.keys(i.env ?? {}).map((k) => [k, { label: k, secret: /PASS|SECRET|TOKEN|KEY/.test(k) }]),
    ),
    data: i.dataPath ? [{ containerPath: i.dataPath.replace(/\/+$/, ""), ...(owner ? { owner } : {}) }] : [],
  });
}
