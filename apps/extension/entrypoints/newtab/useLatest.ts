import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ArchiveArticleMeta, FeedItem, FeedSource, FeedSourceStatus } from "@homepage/agent-core";
import { createArchiveBridge } from "@/lib/archive";
import { createFeedBridge } from "@/lib/feeds";
import { articleKey } from "./readerEntry";
import { loadSources } from "@/lib/sources";

/** How far back the stream reaches, and how many stories one publication may contribute. */
export const LATEST_HOURS = 72;
export const LATEST_PER_SOURCE = 20;
export const REFRESH_MS = 5 * 60_000;

export interface LatestState {
  /** "loading" until the first fetch finishes. */
  phase: "loading" | "ready";
  /** Every source in the catalog, enabled or not. */
  catalog: FeedSource[];
  items: FeedItem[];
  /** One per enabled source from the last fetch. */
  statuses: FeedSourceStatus[];
  updatedAt: number | null;
  refreshing: boolean;
  /** The sources list itself could not be read. */
  sourcesError: string | null;
}

const INITIAL: LatestState = {
  phase: "loading",
  catalog: [],
  items: [],
  statuses: [],
  updatedAt: null,
  refreshing: false,
  sourcesError: null,
};

function time(item: FeedItem, now: number): number {
  const t = item.publishedAt ? Date.parse(item.publishedAt) : NaN;
  return Number.isNaN(t) || t > now + 86_400_000 ? -Infinity : t;
}

function newestFirst(items: FeedItem[]): FeedItem[] {
  const now = Date.now();
  return [...items].sort((a, b) => time(b, now) - time(a, now));
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

/**
 * The Latest view's data: the user's sources' newest stories, fetched from the
 * page (not the worker), refreshed every five minutes while `active`, plus an
 * index of what Amber already has so rows can say "In Amber".
 */
export function useLatest({
  archiveUrl,
  active,
  reloadToken,
}: {
  /** null until settings load; "" means the archive is off. */
  archiveUrl: string | null;
  /** The Latest view is on screen and nothing covers it. */
  active: boolean;
  /** Bumped when Settings closes, since the sources may have changed. */
  reloadToken: number;
}) {
  const [state, setState] = useState<LatestState>(INITIAL);
  const [archived, setArchived] = useState<ArchiveIndex>(() => indexArchive([]));
  const generation = useRef(0);
  const stateRef = useRef(state);
  stateRef.current = state;

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

  const refresh = useCallback(async () => {
    if (archiveUrl === null) return;
    const gen = ++generation.current;
    setState((s) => ({ ...s, refreshing: true }));
    loadArchive(gen);
    let catalog: FeedSource[] = [];
    let sourcesError: string | null = null;
    try {
      catalog = await loadSources();
    } catch (err) {
      sourcesError = err instanceof Error ? err.message : String(err);
    }
    const enabled = catalog.filter((s) => s.enabled);
    let items: FeedItem[] = [];
    let statuses: FeedSourceStatus[] = [];
    if (enabled.length > 0) {
      try {
        ({ items, sources: statuses } = await createFeedBridge(enabled).fetchLatest({
          sinceHours: LATEST_HOURS,
          perSource: LATEST_PER_SOURCE,
        }));
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        statuses = enabled.map((s) => ({ name: s.name, count: 0, error: detail }));
      }
    }
    if (gen !== generation.current) return;
    setState((s) => {
      // A fetch that got nothing at all keeps the stories already on screen.
      const failedAll = enabled.length > 0 && statuses.every((st) => st.error && st.count === 0);
      return {
        phase: "ready",
        catalog,
        items: failedAll && s.items.length > 0 ? s.items : items,
        statuses,
        updatedAt: failedAll && s.updatedAt ? s.updatedAt : Date.now(),
        refreshing: false,
        sourcesError,
      };
    });
  }, [archiveUrl, loadArchive]);

  /** Re-fetch one publication and splice it in, leaving the others as they were. */
  const retrySource = useCallback(
    async (name: string) => {
      const source = stateRef.current.catalog.find((s) => s.name === name && s.enabled);
      if (!source) return;
      const gen = generation.current;
      let items: FeedItem[] = [];
      let status: FeedSourceStatus;
      try {
        const result = await createFeedBridge([source]).fetchLatest({
          sinceHours: LATEST_HOURS,
          perSource: LATEST_PER_SOURCE,
        });
        items = result.items;
        status = result.sources[0] ?? { name, count: 0 };
      } catch (err) {
        status = { name, count: 0, error: err instanceof Error ? err.message : String(err) };
      }
      if (gen !== generation.current) return;
      setState((s) => {
        const others = s.items.filter((i) => i.source !== name);
        const seen = new Set(others.map((i) => articleKey(i.link)));
        const merged = [...others, ...items.filter((i) => !seen.has(articleKey(i.link)))];
        return {
          ...s,
          items: newestFirst(merged),
          statuses: s.statuses.map((st) => (st.name === name ? status : st)),
        };
      });
    },
    [],
  );

  // First load, and again when the address or the sources list changed.
  useEffect(() => {
    void refresh();
    return () => {
      generation.current++;
    };
  }, [refresh, reloadToken]);

  // Keep it fresh while it is being looked at.
  useEffect(() => {
    if (!active) return;
    const last = stateRef.current.updatedAt;
    if (last !== null && Date.now() - last >= REFRESH_MS) void refresh();
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

  const enabledCount = useMemo(() => state.catalog.filter((s) => s.enabled).length, [state.catalog]);
  return { state, archived, enabledCount, refresh, retrySource };
}
