import { useState, type CSSProperties } from "react";
import { accentFor, artworkFor } from "./api";

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
  return accent ? { className: "", style: { "--tone": accent, "--tone-bg": `color-mix(in srgb, ${accent} 16%, var(--bg))` } as CSSProperties } : { className: `tone-${gameTone(templateId)}` };
}

/** The game's picture in the tile, cropped to fit; the coloured letter shows when there is none or it does not load. */
export function GameIcon({ id, name }: { id: string; name: string }) {
  const g = gameStyle(id);
  const art = artworkFor(id);
  const [failed, setFailed] = useState<string | null>(null);
  const showArt = art !== null && failed !== art.url;
  return (
    <span className={`game-icon ${g.className}`.trim()} style={g.style} aria-hidden="true">
      {showArt ? <img src={art.url} alt="" style={{ objectPosition: `50% ${art.position}%` }} onError={() => setFailed(art.url)} /> : name.charAt(0).toUpperCase()}
    </span>
  );
}
