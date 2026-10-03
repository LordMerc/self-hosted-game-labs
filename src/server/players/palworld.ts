import type { PlayerCount } from "./a2s.js";

/**
 * Read the player counts out of Palworld's REST API `/v1/api/metrics` reply. Null if it is not one. The API prints the
 * JSON on its own, but whatever the exec adds around it is ignored by taking the outermost braces.
 */
export function parsePalworldMetrics(text: string): PlayerCount | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) return null;
  try {
    const m = JSON.parse(text.slice(start, end + 1)) as { currentplayernum?: unknown; maxplayernum?: unknown };
    if (typeof m.currentplayernum !== "number" || !Number.isInteger(m.currentplayernum) || m.currentplayernum < 0) return null;
    const max = typeof m.maxplayernum === "number" && Number.isInteger(m.maxplayernum) && m.maxplayernum > 0 ? m.maxplayernum : 0;
    return { online: m.currentplayernum, max };
  } catch {
    return null;
  }
}
