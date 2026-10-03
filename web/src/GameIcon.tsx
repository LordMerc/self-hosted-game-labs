import type { CSSProperties } from "react";
import { accentFor } from "./api";

const gameTones = ["green", "orange", "teal", "violet", "amber", "red"] as const;

/** Stable colour per game, for templates that do not name one. */
function gameTone(templateId: string) {
  let h = 0;
  for (const c of templateId) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return gameTones[h % gameTones.length];
}

/** A game's colour: its template's `accent` when it has one, otherwise one picked from its id. Same on every page. */
export function gameStyle(templateId: string): { className: string; style?: CSSProperties } {
  const accent = accentFor(templateId);
  return accent ? { className: "", style: { "--tone": accent, "--tone-bg": `color-mix(in srgb, ${accent} 16%, #0d0e11)` } as CSSProperties } : { className: `tone-${gameTone(templateId)}` };
}

export function GameIcon({ id, name }: { id: string; name: string }) {
  const g = gameStyle(id);
  return (
    <span className={`game-icon ${g.className}`.trim()} style={g.style} aria-hidden="true">
      {name.charAt(0).toUpperCase()}
    </span>
  );
}
