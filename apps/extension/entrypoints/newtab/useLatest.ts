import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  isBlocked,
  isSourceBlocked,
  type ArchiveArticleMeta,
  type FeedItem,
  type FeedSource,
  type FeedSourceStatus,
} from "@homepage/agent-core";
import { createArchiveBridge } from "@/lib/archive";
import { fetchSourceFeeds, mergeSourceFetches, type SourceFetch } from "@/lib/feeds";
import { loadSources } from "@/lib/sources";
import { KEYS } from "@/lib/storage";
import { articleKey } from "./readerEntry";

/** How far back the stream reaches, and how many stories one publication may contribute. */
export const LATEST_HOURS = 72;
export const LATEST_PER_SOURCE = 20;
/** Every new tab shows the stored fetch and only refetches when it is older than this. */
export const REFRESH_MS = 5 * 60_000;

/** What is stored is bounded: links longer than this are dropped, and nothing over this size is written. */
const MAX_STORED_LINK = 2000;
const MAX_STORED_BYTES = 1_500_000;

/** What is stored under `KEYS.latestFeed`: one fetch, valid for the sources that produced it. */
interface StoredFeed {
  v: 1;
  sourcesHash: string;
  fetchedAt: number;
  results: Array<Omit<SourceFetch, "done">>;
}

export interface LatestState {
  /** "loading" until the first source (or the stored fetch) has something to show. */
  phase: "loading" | "ready";
  /** Every source in the catalog, enabled or not. */
  catalog: FeedSource[];
  /** What each enabled source has given so far, in catalog order. */
  results: Array<Omit<SourceFetch, "done">>;
  /** Names of sources whose feeds are still on their way. */
  pending: string[];
  /** When the shown stories were fetched. */
  updatedAt: number | null;
  refreshing: boolean;
  /** The sources list itself could not be read. */
  sourcesError: string | null;
}

const INITIAL: LatestState = {
  phase: "loading",
  catalog: [],
  results: [],
  pending: [],
  updatedAt: null,
  refreshing: false,
  sourcesError: null,
};

/** A short fingerprint of what would be fetched: names and addresses of the enabled sources. */
function hashSources(sources: FeedSource[]): string {
  const text = sources.map((s) => `${s.id}\n${s.name}\n${[...s.feedUrls].sort().join("\n")}`).join("\u0001");
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return `${sources.length}:${(h >>> 0).toString(16)}`;
}

/** What gets written: each source capped the way the stream caps it, so the stored fetch stays small. */
function boundedResults(results: Array<Omit<SourceFetch, "done">>, now: number): StoredFeed["results"] {
  return results.map((r) => {
    const { items } = mergeSourceFetches([{ ...r, done: true }], {
      sinceHours: LATEST_HOURS,
      perSource: LATEST_PER_SOURCE,
      now,
    });
    const kept = items.filter((i) => i.link.length <= MAX_STORED_LINK);
    return r.error ? { name: r.name, items: kept, error: r.error } : { name: r.name, items: kept };
  });
}

/** Store a fetch for every new tab. Never throws: too big or unavailable storage just means the next tab fetches. */
async function persist(sourcesHash: string, fetchedAt: number, results: Array<Omit<SourceFetch, "done">>) {
  try {
    const value: StoredFeed = { v: 1, sourcesHash, fetchedAt, results: boundedResults(results, fetchedAt) };
    const size = JSON.stringify(value).length;
    if (size > MAX_STORED_BYTES) {
      console.warn(`[latest] not caching the fetch: ${size} bytes is over ${MAX_STORED_BYTES}`);
      return;
    }
    await browser.storage.local.set({ [KEYS.latestFeed]: value });
  } catch {
    /* the next tab just fetches */
  }
}

function isStored(value: unknown): value is StoredFeed {
  const v = value as StoredFeed | undefined;
  return (
    !!v &&
    v.v === 1 &&
    typeof v.sourcesHash === "string" &&
    typeof v.fetchedAt === "number" &&
    Array.isArray(v.results) &&
    v.results.every((r) => r && typeof r.name === "string" && Array.isArray(r.items))
  );
}

/** The archive's articles keyed by the address they were saved under, with and without a query string. */
function indexArchive(articles: ArchiveArticleMeta[]) {
  const exact = new Map<string, ArchiveArticleMeta>();
  const bare = new Map<string, ArchiveArticleMeta>();
  for (const article of articles) {
    for (const address of [article.originalUrl, article.permalink]) {
      if (!address) continue;
      const key = articleKey(address);
      if (!exact.has(key)) exact.set(key, article);
      try {
        const u = new URL(address);
        u.search = "";
        const stripped = articleKey(u.toString());
        if (!bare.has(stripped)) bare.set(stripped, article);
      } catch {
        /* not an address */
      }
    }
  }
  return { exact, bare };
}

export type ArchiveIndex = ReturnType<typeof indexArchive>;

/** The saved copy of a feed item, if the archive has one. A query-less match only counts for a query-less link. */
export function findArchived(
  index: ArchiveIndex,
  extra: Map<string, ArchiveArticleMeta>,
  link: string,
): ArchiveArticleMeta | undefined {
  const key = articleKey(link);
  const direct = extra.get(key) ?? index.exact.get(key);
  if (direct) return direct;
  try {
    if (new URL(link).search === "") return index.bare.get(key);
  } catch {
    /* not an address */
  }
  return undefined;
}

/** Items of `previous` that `next` doesn't have, appended to `next`: a feed that is part-way in doesn't shrink the source. */
function union(next: FeedItem[], previous: FeedItem[]): FeedItem[] {
  const have = new Set(next.map((i) => i.id));
  return [...next, ...previous.filter((i) => !have.has(i.id))];
}

/**
 * The Latest view's data: the user's sources' newest stories.
 *
 * - Fetched from the page (not the worker), all sources in parallel, and shown as
 *   each source settles, so a slow feed never holds the others back.
 * - The last fetch is stored (`KEYS.latestFeed`) and shared by every new tab: a
 *   tab shows it at once and refetches by itself only when it is older than five
 *   minutes or the sources changed. A source that failed counts as fetched (it
 *   has its own Retry); the refresh button and Retry fetch on demand.
 * - A source whose publisher is on the blocked list, or whose feed address is on
 *   a private host, is not requested at all; stories on a blocked site (by link
 *   host) are dropped here, on the page.
 * - An index of what Amber already has lets rows say "In Amber".
 */
export function useLatest({
  archiveUrl,
  active,
  reloadToken,
  blockedSites,
}: {
  /** null until settings load; "" means the archive is off. */
  archiveUrl: string | null;
  /** The Latest view is on screen and nothing covers it. */
  active: boolean;
  /** Bumped when Settings closes, since the sources may have changed. */
  reloadToken: number;
  blockedSites: string[];
}) {
  const [state, setState] = useState<LatestState>(INITIAL);
  const [archived, setArchived] = useState<ArchiveIndex>(() => indexArchive([]));
  const generation = useRef(0);
  const archiveLoaded = useRef(false);
  const stateRef = useRef(state);
  stateRef.current = state;
  /** The blocked list as a stable value: a new array with the same sites must not refetch. */
  const blockedKey = JSON.stringify(blockedSites);
  const blockedRef = useRef(blockedSites);
  blockedRef.current = blockedSites;
  const controllerRef = useRef<AbortController | null>(null);
  /** What the shown fetch was made for, so a retried source can be written back to the cache. */
  const hashRef = useRef("");

  const loadArchive = useCallback(
    (gen: number) => {
      if (!archiveUrl || archiveUrl.trim() === "") {
        setArchived(indexArchive([]));
        return;
      }
      createArchiveBridge(archiveUrl)
        .listArticles({ sinceDays: 365, limit: 200 })
        .then((list) => {
          if (gen === generation.current) setArchived(indexArchive(list.articles));
        })
        .catch(() => {
          /* no marker without the archive; the stream itself still works */
        });
    },
    [archiveUrl],
  );

  /**
   * Show the stored fetch if there is one, and fetch again unless it is fresh.
   * `force` (the refresh button) always fetches.
   */
  const refresh = useCallback(
    async ({ force = false }: { force?: boolean } = {}) => {
      if (archiveUrl === null) return;
      const gen = ++generation.current;
      const current = () => gen === generation.current;
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      setState((s) => ({ ...s, refreshing: true }));

      let catalog: FeedSource[] = [];
      let sourcesError: string | null = null;
      try {
        catalog = await loadSources();
      } catch (err) {
        sourcesError = err instanceof Error ? err.message : String(err);
      }
      if (!current()) return;
      const enabled = catalog.filter((s) => s.enabled && !isSourceBlocked(s, blockedRef.current));
      const hash = hashSources(enabled);
      hashRef.current = hash;

      let stored: StoredFeed | undefined;
      try {
        const value = (await browser.storage.local.get(KEYS.latestFeed))[KEYS.latestFeed];
        if (isStored(value) && value.sourcesHash === hash) stored = value;
      } catch {
        /* no stored fetch */
      }
      if (!current()) return;

      // What to show first: the stored fetch, else whatever is on screen for sources still enabled.
      const byName = new Map<string, Omit<SourceFetch, "done">>();
      const seed = stored?.results ?? stateRef.current.results.filter((r) => enabled.some((s) => s.name === r.name));
      for (const r of seed) byName.set(r.name, r);
      const ordered = () => enabled.map((s) => byName.get(s.name) ?? { name: s.name, items: [] as FeedItem[] });

      if (enabled.length === 0) {
        setState({ ...INITIAL, phase: "ready", catalog, sourcesError });
        try {
          await browser.storage.local.remove(KEYS.latestFeed);
        } catch {
          /* nothing to clear */
        }
        return;
      }

      // A source that failed is part of a fresh fetch: it has its own Retry, and refetching every
      // feed on every new tab because one of them is down would break "once every five minutes".
      const fresh = !!stored && Date.now() - stored.fetchedAt < REFRESH_MS;
      const showing = byName.size > 0;
      setState((s) => ({
        ...s,
        phase: showing ? "ready" : s.phase,
        catalog,
        sourcesError,
        results: ordered(),
        updatedAt: stored ? stored.fetchedAt : showing ? s.updatedAt : null,
        pending: [],
        refreshing: !(fresh && !force),
      }));
      if (force || !archiveLoaded.current) loadArchive(gen);
      archiveLoaded.current = true;
      if (fresh && !force) return;

      const window = { sinceHours: LATEST_HOURS, perSource: LATEST_PER_SOURCE };
      const pendingNames = new Set(enabled.map((s) => s.name));
      setState((s) => ({ ...s, pending: [...pendingNames] }));
      const fetchedAt = Date.now();

      await Promise.all(
        enabled.map((source) =>
          fetchSourceFeeds(source, { ...window, now: fetchedAt }, {
            signal: controller.signal,
            onProgress: (partial) => {
              if (!current()) return;
              const before = byName.get(source.name)?.items ?? [];
              let items = partial.items;
              let error = partial.error;
              if (!partial.done) items = union(partial.items, before);
              else if (partial.error && partial.items.length === 0) items = before; // keep the stale copy, say it failed
              else if (partial.items.length > 0 && partial.error) items = partial.items;
              byName.set(source.name, { name: source.name, items, error });
              if (partial.done) pendingNames.delete(source.name);
              setState((s) => ({
                ...s,
                phase: "ready",
                results: ordered(),
                pending: [...pendingNames],
              }));
            },
          }),
        ),
      );
      if (!current()) return;

      const results = ordered();
      setState((s) => ({ ...s, results, pending: [], updatedAt: fetchedAt, refreshing: false }));
      await persist(hash, fetchedAt, results);
    },
    // `blockedKey` (not the array) so the same list read again does not look like a change.
    [archiveUrl, loadArchive, blockedKey],
  );

  /** Re-fetch one publication and splice it in, leaving the others as they were. */
  const retrySource = useCallback(async (name: string) => {
    const source = stateRef.current.catalog.find((s) => s.name === name && s.enabled);
    if (!source) return;
    const gen = generation.current;
    setState((s) => ({ ...s, pending: [...new Set([...s.pending, name])] }));
    const result = await fetchSourceFeeds(
      source,
      { sinceHours: LATEST_HOURS, perSource: LATEST_PER_SOURCE },
      { signal: controllerRef.current?.signal },
    );
    if (gen !== generation.current) return;
    const results = stateRef.current.results.map((r) =>
      r.name === name
        ? { name, items: result.error && result.items.length === 0 ? r.items : result.items, error: result.error }
        : r,
    );
    setState((s) => ({ ...s, results, pending: s.pending.filter((n) => n !== name) }));
    // The other sources keep their own fetch time, so a retry never makes the whole fetch look newer.
    void persist(hashRef.current, stateRef.current.updatedAt ?? Date.now(), results);
  }, []);

  // First load, and again when the address or the sources list changed.
  useEffect(() => {
    archiveLoaded.current = false;
    void refresh();
    return () => {
      generation.current++;
      controllerRef.current?.abort();
    };
  }, [refresh, reloadToken]);

  // Keep it fresh while it is being looked at; `refresh` itself skips a fetch another tab just did.
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      if (!document.hidden) void refresh();
    }, REFRESH_MS);
    const onVisible = () => {
      const at = stateRef.current.updatedAt;
      if (!document.hidden && at !== null && Date.now() - at >= REFRESH_MS) void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [active, refresh]);

  // The sources being read: switched on, and not blocked by publisher or by a private feed address.
  const { sources, blockedCount } = useMemo(() => {
    const on = state.catalog.filter((s) => s.enabled);
    const open = on.filter((s) => !isSourceBlocked(s, blockedSites));
    return { sources: open, blockedCount: on.length - open.length };
  }, [state.catalog, blockedSites]);

  // The stream, with blocked sources removed and stories dropped by the host of each link.
  const { items, statuses } = useMemo<{ items: FeedItem[]; statuses: FeedSourceStatus[] }>(() => {
    const names = new Set(sources.map((s) => s.name));
    const allowed = state.results
      .filter((r) => names.has(r.name))
      .map((r) => ({
        ...r,
        done: true,
        items: r.items.filter((i) => !isBlocked(i.link, blockedSites)),
      }));
    const merged = mergeSourceFetches(allowed, { sinceHours: LATEST_HOURS, perSource: LATEST_PER_SOURCE });
    return { items: merged.items, statuses: merged.sources };
  }, [state.results, sources, blockedSites]);

  const sourceNames = useMemo(() => sources.map((s) => s.name), [sources]);
  return {
    state,
    items,
    statuses,
    archived,
    sourceNames,
    enabledCount: sources.length,
    blockedCount,
    refresh,
    retrySource,
  };
}
