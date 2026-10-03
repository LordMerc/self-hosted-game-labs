import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icons";

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // The panel is usually served over plain http on the LAN, where the async clipboard API is unavailable.
  }
  const el = document.createElement("textarea");
  el.value = text;
  el.style.position = "fixed";
  el.style.opacity = "0";
  document.body.appendChild(el);
  el.select();
  document.execCommand("copy");
  el.remove();
}

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <button
      className={`icon-btn${done ? " ok" : ""}`}
      title={done ? "Copied" : label}
      aria-label={label}
      onClick={async () => {
        await copyText(text);
        setDone(true);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setDone(false), 1500);
      }}
    >
      <Icon name={done ? "check" : "copy"} size={15} />
    </button>
  );
}
