export function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return s || "server";
}

/** palworld, palworld-2, palworld-3, ... */
export function uniqueSlug(base: string, existing: ReadonlySet<string>): string {
  if (!existing.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!existing.has(candidate)) return candidate;
  }
}
