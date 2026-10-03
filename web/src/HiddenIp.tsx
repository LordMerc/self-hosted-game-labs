import { useState } from "react";
import { CopyButton } from "./CopyButton";
import { Icon } from "./Icons";

/** True for a bare IPv4/IPv6 address, or one followed by `:port`. Hostnames are not IPs and are left alone. */
export function isIpAddress(value: string): boolean {
  const host = value.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || (host.includes(":") && /^[0-9a-f:]+$/i.test(host));
}

/**
 * Shows an IP address blurred until the user clicks the eye button, so a screenshot of the dashboard does not leak it.
 * The state is deliberately local and unpersisted: every page load starts hidden, and nothing ever reveals it automatically.
 * While hidden, a same-shaped placeholder is rendered instead of the real text, so the blur cannot be undone.
 */
export function HiddenIp({ value, className, copy = false }: { value: string; className?: string; copy?: boolean }) {
  const [shown, setShown] = useState(false);
  return (
    <span className="hidden-ip">
      <span className={`${className ?? ""}${shown ? "" : " blurred"}`} aria-label={shown ? undefined : "Hidden"}>
        {shown ? value : value.replace(/[0-9a-f]/gi, "0")}
      </span>
      <button className="icon-btn" onClick={() => setShown(!shown)} aria-pressed={shown} aria-label={shown ? "Hide IP address" : "Show IP address"} title={shown ? "Hide" : "Show"}>
        <Icon name={shown ? "eye-off" : "eye"} size={15} />
      </button>
      {copy && <CopyButton text={value} label="Copy public IP" />}
    </span>
  );
}
