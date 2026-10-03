import type { CSSProperties } from "react";

/**
 * A row of thin bars, one per sample, newest on the right. Gaps (no reading) are left empty rather than drawn as zero.
 * `floor` keeps a quiet series from being stretched into a mountain: bars are scaled to the larger of the biggest value and the floor.
 */
export function Spark({ values, floor = 1, tone, label }: { values: (number | null)[]; floor?: number; tone: string; label: string }) {
  const real = values.filter((v): v is number => v !== null);
  const top = Math.max(floor, ...real);
  const last = values.length - 1;
  return (
    <div className="spark" role="img" aria-label={label} style={{ "--tone": tone } as CSSProperties}>
      {values.length === 0 ? <span className="spark-empty" /> : values.map((v, i) => <span key={i} className={`bar${i === last && v !== null ? " now" : ""}${v === null ? " gap" : ""}`} style={{ height: v === null ? undefined : `${Math.max(8, (v / top) * 100)}%` }} />)}
    </div>
  );
}
