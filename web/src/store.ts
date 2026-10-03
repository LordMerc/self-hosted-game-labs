import { useCallback, useEffect, useSyncExternalStore } from "react";
import { api, loadTemplates } from "./api";

/**
 * A small app-level cache for what the pages show, kept at module level so it survives moving between pages.
 * A page asks for a path and gets the last answer at once (if there is one) while a fresh one is fetched in the
 * background; the screen only shows a placeholder the very first time something is asked for.
 */
interface Entry {
  data: unknown;
  /** When `data` arrived (ms since epoch); 0 = never. */
  at: number;
  error: string | null;
  inflight: Promise<unknown> | null;
  subs: Set<() => void>;
}

const entries = new Map<string, Entry>();
/** Bumped by clearCache, so a request that was already on its way when someone signed out cannot refill the cache. */
let epoch = 0;

function entry(path: string): Entry {
  let e = entries.get(path);
  if (!e) entries.set(path, (e = { data: undefined, at: 0, error: null, inflight: null, subs: new Set() }));
  return e;
}

const notify = (e: Entry) => e.subs.forEach((f) => f());
const fetchPath = (path: string): Promise<unknown> => (path === "/templates" ? loadTemplates() : api(path));

/** Fetches `path` and stores the answer. A request already on its way is joined, not repeated. A failure keeps the old data. */
export function revalidate<T>(path: string): Promise<T | undefined> {
  const e = entry(path);
  if (!e.inflight) {
    const mine = epoch;
    e.inflight = fetchPath(path)
      .then(
        (data) => {
          if (mine !== epoch) return;
          e.data = data;
          e.at = Date.now();
          e.error = null;
        },
        (err: Error) => {
          if (mine !== epoch) return;
          e.error = err.message;
        },
      )
      .finally(() => {
        e.inflight = null;
        notify(e);
      });
  }
  return e.inflight.then(() => e.data as T | undefined);
}

/** Starts fetching `path` unless it was fetched in the last `maxAgeMs`: for warming the cache before a page asks. */
export function prefetch(paths: string[], maxAgeMs = 5000) {
  for (const p of paths) if (Date.now() - entry(p).at > maxAgeMs) void revalidate(p);
}

/** What a page needs, by name, so a link can warm it before it is opened. */
export const pageData = {
  servers: ["/servers", "/network", "/other-panels", "/activity", "/stats", "/templates", "/updates"],
  backups: ["/backups", "/templates"],
  settings: [],
} satisfies Record<string, string[]>;

/** Forgets everything (on sign out, so the next person never sees the last one's servers). */
export function clearCache() {
  epoch++;
  for (const e of entries.values()) {
    e.data = undefined;
    e.at = 0;
    e.error = null;
    notify(e);
  }
}

/**
 * The cached answer for `path` (undefined until the first one arrives), refreshed on mount and then every `everyMs`
 * (none = only on mount). The next poll is timed from the end of the last request, so a slow answer never piles up.
 */
export function useApi<T>(path: string, every?: number | ((data: T | undefined) => number | undefined)) {
  const e = entry(path);
  const subscribe = useCallback((f: () => void) => (e.subs.add(f), () => void e.subs.delete(f)), [e]);
  const data = useSyncExternalStore(subscribe, () => e.data) as T | undefined;
  const error = useSyncExternalStore(subscribe, () => e.error);
  const everyMs = typeof every === "function" ? every(data) : every;
  useEffect(() => void revalidate(path), [path]);
  useEffect(() => {
    if (!everyMs) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const next = () => {
      timer = setTimeout(async () => {
        await revalidate(path);
        if (!stop) next();
      }, everyMs);
    };
    next();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [path, everyMs]);
  const reload = useCallback(() => revalidate<T>(path), [path]);
  return { data, error, reload };
}
