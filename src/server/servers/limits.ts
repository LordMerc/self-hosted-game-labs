import type { GameTemplate } from "../../shared/template.js";

/** Caps on what one game server may use. `null` means no limit. */
export interface Limits {
  cpus: number | null;
  memoryMb: number | null;
}

export const NO_LIMITS: Limits = { cpus: null, memoryMb: null };

/** Docker kills a container that goes over its memory cap, and most games need far more than this anyway. */
export const MIN_MEMORY_MB = 256;
const MAX_MEMORY_MB = 4 * 1024 * 1024;
const MIN_CPUS = 0.1;

export type LimitCheck = { ok: true; value: number | null } | { ok: false; field: "cpus" | "memoryMb"; message: string };

const blank = (v: unknown) => v === null || v === undefined || v === "";

/** CPU cores the game may use, e.g. 1.5. Rounded to hundredths, which is as fine as Docker's own setting. */
export function checkCpus(v: unknown, hostCores: number): LimitCheck {
  if (blank(v)) return { ok: true, value: null };
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n < MIN_CPUS) return { ok: false, field: "cpus", message: `The CPU limit must be a number of cores, at least ${MIN_CPUS}` };
  if (n > hostCores) return { ok: false, field: "cpus", message: `This machine has ${hostCores} CPU cores, so the limit can be at most ${hostCores}` };
  return { ok: true, value: Math.round(n * 100) / 100 };
}

/** Memory the game may use, in MB. */
export function checkMemory(v: unknown): LimitCheck {
  if (blank(v)) return { ok: true, value: null };
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n < MIN_MEMORY_MB) return { ok: false, field: "memoryMb", message: `The memory limit must be at least ${MIN_MEMORY_MB} MB` };
  if (n > MAX_MEMORY_MB) return { ok: false, field: "memoryMb", message: "That memory limit is too large" };
  return { ok: true, value: Math.round(n) };
}

/** What the panel tells the owner when a cap is lower than the game needs. The cap is still allowed. */
export function limitWarnings(t: Pick<GameTemplate, "name" | "resources">, limits: Limits): string[] {
  const min = t.resources.minMemoryMb;
  if (limits.memoryMb !== null && min !== undefined && limits.memoryMb < min) {
    return [`${t.name} needs about ${gb(min)} of memory, so a ${gb(limits.memoryMb)} limit will likely make it run out of memory and restart.`];
  }
  return [];
}

function gb(mb: number): string {
  return `${Number((mb / 1024).toFixed(2))} GB`;
}
