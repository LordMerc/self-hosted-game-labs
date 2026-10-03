import type { ReactNode } from "react";
import { Icon } from "./Icons";

/** Small info icon that shows a short explanation on hover, keyboard focus or tap. */
export function Hint({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className="hint" tabIndex={0} role="note" aria-label={label}>
      <Icon name="info" size={15} />
      <span className="hint-pop" role="tooltip">
        {children}
      </span>
    </span>
  );
}
