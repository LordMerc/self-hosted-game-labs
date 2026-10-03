/**
 * Which panel this is. Every container, router mapping and DNS record the panel creates is tagged with the
 * instance name, and the panel only touches things carrying its own tag. A second panel (for example a beta copy
 * next to the real one) needs a different INSTANCE so the two never reuse or delete each other's things.
 * The default, "gamelabs", produces exactly the names and tags earlier versions used.
 */
export const DEFAULT_INSTANCE = "gamelabs";

export function parseInstance(raw: string | undefined): string {
  const name = (raw ?? "").trim() || DEFAULT_INSTANCE;
  if (!/^[a-z0-9][a-z0-9-]{0,19}$/.test(name)) {
    throw new Error(`Invalid configuration:\n  INSTANCE: use 1-20 lowercase letters, digits or dashes (got "${name}")`);
  }
  return name;
}

export function namesFor(instance: string) {
  return {
    instance,
    /** Docker label keys: `<prefix>.managed`, `<prefix>.id`, `<prefix>.slug`. */
    labelPrefix: instance,
    /** Start of every router mapping description and DNS record comment this panel owns. */
    ownerPrefix: `${instance}:`,
    containerName: (slug: string) => (instance === DEFAULT_INSTANCE ? `gl-${slug}` : `gl-${instance}-${slug}`),
  };
}

export const names = namesFor(parseInstance(process.env.INSTANCE));
