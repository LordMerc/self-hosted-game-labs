import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon, type IconName } from "./Icons";

export interface MenuItem {
  label: string;
  icon: IconName;
  onSelect: () => void;
  disabled?: boolean;
  danger?: boolean;
  /** Draw a line above this item. */
  separated?: boolean;
}

const GAP = 6;
const EDGE = 8;

/**
 * The "..." menu on a row. It is drawn on the page itself (not inside the table, which scrolls sideways and would clip it) and
 * placed beside its button: right edges lined up, below the button, or above it when there is no room below, so it never sits
 * over the neighbouring rows' buttons. Follows its button when the page scrolls, and closes on Escape, a click elsewhere, or choosing an item.
 */
export function RowMenu({ label, items }: { label: string; items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    setPos(null);
    if (refocus) trigger.current?.focus();
  }, []);

  /** Put the menu beside its button; shut it if the button has scrolled out of sight. */
  const place = useCallback(() => {
    if (!trigger.current || !menu.current) return;
    const b = trigger.current.getBoundingClientRect();
    if (b.bottom < 0 || b.top > window.innerHeight) return close(false);
    const m = menu.current.getBoundingClientRect();
    const below = b.bottom + GAP + m.height <= window.innerHeight - EDGE;
    const top = below ? b.bottom + GAP : Math.max(EDGE, b.top - GAP - m.height);
    const left = Math.min(Math.max(EDGE, b.right - m.width), window.innerWidth - m.width - EDGE);
    setPos({ top, left });
  }, [close]);

  useLayoutEffect(() => {
    if (open) place();
  }, [open, place]);

  // Focus the first item once the menu has been placed (a hidden element cannot take focus).
  useEffect(() => {
    if (open && pos) menu.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [open, pos === null]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!menu.current?.contains(e.target as Node) && !trigger.current?.contains(e.target as Node)) close(false);
    };
    document.addEventListener("mousedown", away);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      document.removeEventListener("mousedown", away);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, close, place]);

  function onKey(e: React.KeyboardEvent) {
    const buttons = [...(menu.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "Escape") return e.preventDefault(), e.stopPropagation(), close(true);
    if (e.key === "Tab") return close(false);
    const move = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : e.key === "Home" ? "first" : e.key === "End" ? "last" : 0;
    if (move === 0 || buttons.length === 0) return;
    e.preventDefault();
    buttons[move === "first" ? 0 : move === "last" ? buttons.length - 1 : (at + move + buttons.length) % buttons.length].focus();
  }

  return (
    <>
      <button ref={trigger} className={`icon-btn round${open ? " open" : ""}`} aria-label={label} title={label} aria-haspopup="menu" aria-expanded={open} onClick={() => (open ? close(false) : setOpen(true))}>
        <Icon name="more" size={16} />
      </button>
      {open &&
        createPortal(
          <div ref={menu} className="row-menu" role="menu" aria-label={label} style={pos ? { top: pos.top, left: pos.left } : { top: 0, left: 0, visibility: "hidden" }} onKeyDown={onKey}>
            {items.map((it) => (
              <button
                key={it.label}
                role="menuitem"
                className={`${it.danger ? "danger" : ""}${it.separated ? " sep" : ""}`}
                disabled={it.disabled}
                onClick={() => {
                  close(false);
                  it.onSelect();
                }}
              >
                <Icon name={it.icon} size={15} /> {it.label}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
