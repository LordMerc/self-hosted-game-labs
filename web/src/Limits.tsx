import { Hint } from "./Hint";

/** What the person typed for the two limits. Empty means no limit. Memory is typed in GB, stored in MB. */
export interface LimitInput {
  cpus: string;
  memoryGb: string;
}

export interface Limits {
  cpus: number | null;
  memoryMb: number | null;
}

export const noLimitInput: LimitInput = { cpus: "", memoryGb: "" };

const trim = (n: number) => String(Number(n.toFixed(2)));

export function limitInputFrom(l: Limits): LimitInput {
  return { cpus: l.cpus === null ? "" : trim(l.cpus), memoryGb: l.memoryMb === null ? "" : trim(l.memoryMb / 1024) };
}

/** The typed values as numbers, or the problem in words for the person. */
export function limitsFromInput(i: LimitInput): Limits | string {
  const cpus = i.cpus.trim() === "" ? null : Number(i.cpus);
  const gb = i.memoryGb.trim() === "" ? null : Number(i.memoryGb);
  if (cpus !== null && (!Number.isFinite(cpus) || cpus < 0.1)) return "The CPU limit must be a number of cores, at least 0.1";
  if (gb !== null && (!Number.isFinite(gb) || gb < 0.25)) return "The memory limit must be a number of GB, at least 0.25";
  return { cpus, memoryMb: gb === null ? null : Math.round(gb * 1024) };
}

/** "2 cores · 4 GB" for a server that has a cap, otherwise null. */
export function limitText(l: Limits): string | null {
  const parts = [l.cpus !== null && `${trim(l.cpus)} ${l.cpus === 1 ? "core" : "cores"}`, l.memoryMb !== null && `${trim(l.memoryMb / 1024)} GB`].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** Warn when the memory cap is below what the game is known to need (the cap is still allowed). */
export function memoryWarning(i: LimitInput, game: string, minMemoryMb: number | null | undefined): string | null {
  const l = limitsFromInput(i);
  if (typeof l === "string" || l.memoryMb === null || !minMemoryMb || l.memoryMb >= minMemoryMb) return null;
  return `${game} needs about ${trim(minMemoryMb / 1024)} GB of memory, so a ${trim(l.memoryMb / 1024)} GB limit will likely make it run out of memory and restart.`;
}

export function LimitFields({
  value,
  onChange,
  warning,
  fieldClass,
}: {
  value: LimitInput;
  onChange: (v: LimitInput) => void;
  warning?: string | null;
  fieldClass?: string;
}) {
  return (
    <>
      <label className={fieldClass}>
        <span>
          CPU limit (cores)
          <Hint label="About the CPU limit">The most CPU this game may use, in cores. Leave empty for no limit. Useful so one busy game cannot slow the others down.</Hint>
        </span>
        <input type="number" inputMode="decimal" min="0.1" step="0.1" value={value.cpus} placeholder="No limit" onChange={(e) => onChange({ ...value, cpus: e.target.value })} />
      </label>
      <label className={fieldClass}>
        <span>
          Memory limit (GB)
          <Hint label="About the memory limit">
            The most memory this game may use. If it goes over, it is stopped and restarted. Leave empty for no limit. Keep it above any memory setting the game has itself.
          </Hint>
        </span>
        <input type="number" inputMode="decimal" min="0.25" step="0.25" value={value.memoryGb} placeholder="No limit" onChange={(e) => onChange({ ...value, memoryGb: e.target.value })} />
        {warning && <span className="warn small-text wrap">{warning}</span>}
      </label>
    </>
  );
}
