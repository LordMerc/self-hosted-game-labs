import { useState, type CSSProperties } from "react";
import type { Server, Template } from "./api";
import { gameStyle } from "./GameIcon";
import { Icon } from "./Icons";

const mem = (mb: number) => (mb >= 1000 ? `${Math.round(mb / 100) / 10} GB` : `${mb} MB`);

/** One line under a game's name: what it needs and how many can join, only from what the template says. */
function facts(t: Template) {
  return [t.minMemoryMb ? `${mem(t.minMemoryMb)} RAM` : null, t.maxPlayers ? `up to ${t.maxPlayers} players` : null].filter(Boolean).join(" · ") || "Docker template";
}

/** How many templates sit on the page; the rest are behind "View more". */
const SHOWN = 4;

function TemplateCard({ t, installed, onPick }: { t: Template; installed: boolean; onPick: (t: Template) => void }) {
  const g = gameStyle(t.id);
  return (
    <button className="template-card" onClick={() => onPick(t)}>
      <span className={`card-banner ${g.className}`.trim()} style={{ ...g.style, ...(t.artwork ? ({ "--art": `url(${t.artwork})` } as CSSProperties) : {}) }} data-art={t.artwork ? "yes" : undefined} aria-hidden="true">
        <span className="banner-letter">{t.name.charAt(0)}</span>
        {installed && <span className="tag">Installed</span>}
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
}

function CustomCard({ onCustom }: { onCustom: () => void }) {
  return (
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
  );
}

/**
 * The one-click templates, as cards with a colour wash per game. The first few sit on the page; "View more" opens a dialog with
 * every template and the custom image. A template can name its own accent colour and, optionally, ship a picture; none are
 * included by default, so the repository carries no third-party game art.
 */
export function DeployCards({ templates, servers, hero, onPick, onCustom }: { templates: Template[]; servers: Server[]; hero: boolean; onPick: (t: Template) => void; onCustom: () => void }) {
  const [all, setAll] = useState(false);
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
        {templates.slice(0, SHOWN).map((t) => (
          <TemplateCard key={t.id} t={t} installed={installed.has(t.id)} onPick={onPick} />
        ))}
      </div>
      <button className="view-more" onClick={() => setAll(true)}>
        View more
      </button>
      {all && (
        <div className="backdrop">
          <div className="card dialog templates-dialog" role="dialog" aria-modal="true" aria-label="All games">
            <div className="row between">
              <h2>Deploy a new server</h2>
              <button className="ghost" onClick={() => setAll(false)}>
                Close
              </button>
            </div>
            <div className="templates">
              {templates.map((t) => (
                <TemplateCard
                  key={t.id}
                  t={t}
                  installed={installed.has(t.id)}
                  onPick={(picked) => {
                    setAll(false);
                    onPick(picked);
                  }}
                />
              ))}
              <CustomCard
                onCustom={() => {
                  setAll(false);
                  onCustom();
                }}
              />
            </div>
          </div>
        </div>
      )}
    </>
  );
}
