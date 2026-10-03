import { type CSSProperties } from "react";
import type { Server, Template } from "./api";
import { gameStyle } from "./GameIcon";
import { Icon } from "./Icons";

const mem = (mb: number) => (mb >= 1000 ? `${Math.round(mb / 100) / 10} GB` : `${mb} MB`);

/** One line under a game's name: what it needs and how many can join, only from what the template says. */
function facts(t: Template) {
  return [t.minMemoryMb ? `${mem(t.minMemoryMb)} RAM` : null, t.maxPlayers ? `up to ${t.maxPlayers} players` : null].filter(Boolean).join(" · ") || "Docker template";
}

/**
 * The one-click templates, as cards with a colour wash per game. A template can name its own accent colour and, optionally,
 * ship a picture; none are included by default, so the repository carries no third-party game art.
 */
export function DeployCards({ templates, servers, hero, onPick, onCustom }: { templates: Template[]; servers: Server[]; hero: boolean; onPick: (t: Template) => void; onCustom: () => void }) {
  const installed = new Set(servers.map((s) => s.templateId));
  return (
    <>
      <div className="deploy-head">
        <div>
          <h2>{hero ? "Deploy your first server" : "Deploy a new server"}</h2>
          <p className="muted">{hero ? "Pick a game and the panel starts it in Docker, with the ports ready to open." : "One-click Docker templates"}</p>
        </div>
        <a className="text-btn" href="https://github.com/LordMerc/self-hosted-game-labs/blob/main/CONTRIBUTING.md" target="_blank" rel="noreferrer">
          Contribute a template <Icon name="external" size={13} />
        </a>
      </div>
      <div className="templates">
        {templates.map((t) => {
          const g = gameStyle(t.id);
          return (
            <button key={t.id} className="template-card" onClick={() => onPick(t)}>
              <span className={`card-banner ${g.className}`.trim()} style={{ ...g.style, ...(t.artwork ? ({ "--art": `url(${t.artwork})` } as CSSProperties) : {}) }} data-art={t.artwork ? "yes" : undefined} aria-hidden="true">
                <span className="banner-letter">{t.name.charAt(0)}</span>
                {installed.has(t.id) && <span className="tag">Installed</span>}
              </span>
              <span className="card-foot">
                <span className="card-text">
                  <strong>{t.name}</strong>
                  <span className="muted">{facts(t)}</span>
                </span>
                <span className="card-plus" aria-hidden="true">
                  <Icon name="plus" size={15} />
                </span>
              </span>
            </button>
          );
        })}
        <button className="template-card custom" onClick={onCustom}>
          <span className="card-banner tone-custom" aria-hidden="true">
            <span className="banner-letter">+</span>
          </span>
          <span className="card-foot">
            <span className="card-text">
              <strong>Custom Docker image</strong>
              <span className="muted">Any image, your own ports</span>
            </span>
            <span className="card-plus" aria-hidden="true">
              <Icon name="plus" size={15} />
            </span>
          </span>
        </button>
      </div>
    </>
  );
}
