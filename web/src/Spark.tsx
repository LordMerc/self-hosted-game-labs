import type { CSSProperties } from "react";

/**
 * A row of thin bars, one per sample, newest on the right. Gaps (no reading) are left empty rather than drawn as zero.
 * `floor` keeps a quiet series from being stretched into a mountain: bars are scaled to the larger of the biggest value and the floor.
 * `relative` starts the scale at the series' lowest value instead of zero, for a figure (memory) that moves a little around a large base.
 */
const MINI_BARS = 24;

/** Averages a long series down to `n` bars (a gap stays a gap when nothing in its slice was measured). */
function thin(values: (number | null)[], n: number): (number | null)[] {
  if (values.length <= n) return values;
  return Array.from({ length: n }, (_, i) => {
    const part = values.slice(Math.floor((i * values.length) / n), Math.floor(((i + 1) * values.length) / n)).filter((v): v is number => v !== null);
    return part.length === 0 ? null : part.reduce((a, b) => a + b, 0) / part.length;
  });
}

export function Spark({ values: all, floor = 1, tone, label, mini = false, relative = false }: { values: (number | null)[]; floor?: number; tone: string; label: string; mini?: boolean; relative?: boolean }) {
  const values = mini ? thin(all, MINI_BARS) : all;
  const real = values.filter((v): v is number => v !== null);
  const lo = relative && real.length > 0 ? Math.min(...real) : 0;
  const top = Math.max(lo + floor, ...real) - lo;
  const last = values.length - 1;
  return (
    <div className={`spark${mini ? " mini" : ""}`} role="img" aria-label={label} style={{ "--tone": tone } as CSSProperties}>
      {values.length === 0 ? <span className="spark-empty" /> : values.map((v, i) => <span key={i} className={`bar${i === last && v !== null ? " now" : ""}${v === null ? " gap" : ""}`} style={{ height: v === null ? undefined : `${Math.max(8, ((v - lo) / top) * 100)}%` }} />)}
    </div>
  );
}
