import type { ArchiveArticle, ArchiveArticleMeta, ArchiveBridge } from "@homepage/agent-core";
import { normalizeArchiveUrl } from "@homepage/agent-core";
import {
  createArchiveBridge,
  LIST_TIMEOUT_MS,
  parseSnapshotArticle,
  parseSnapshotList,
  TEXT_TIMEOUT_MS,
} from "./archive";
import { fallbackBaseOf, type ArchiveAuth } from "./archive-auth";
import { createOriginCache, raceArchiveJson, type OriginCache, type RaceSuccess } from "./archive-race";
import { passwordFingerprint, readerAuthStillRejected } from "./rebuild-request";
import { KEYS, loadSettings } from "./storage";

/**
 * The Mac/fallback decision shared by every extension context. Timestamps are
 * written through so a new tab doesn't race again during the up or down window.
 * The list already on screen is not stored here: a late Mac win updates this
 * cache and leaves that list where it is.
 */
const sharedCache = createOriginCache();
let cacheUpdatedAt = 0;

interface StoredCache extends OriginCache {
  updatedAt?: number;
}

async function refreshSharedCache(): Promise<void> {
  try {
    const bag = await browser.storage.local.get(KEYS.archiveOriginCache);
    const raw = bag[KEYS.archiveOriginCache] as StoredCache | undefined;
    if (!raw || typeof raw.updatedAt !== "number" || raw.updatedAt < cacheUpdatedAt) return;
    sharedCache.upUntil = typeof raw.upUntil === "number" ? raw.upUntil : null;
    sharedCache.downUntil = typeof raw.downUntil === "number" ? raw.downUntil : null;
    cacheUpdatedAt = raw.updatedAt;
  } catch {
    /* This page keeps the memory copy. */
  }
}

function persistSharedCache(): void {
  cacheUpdatedAt = Date.now();
  const snapshot: StoredCache = {
    upUntil: sharedCache.upUntil,
    downUntil: sharedCache.downUntil,
    updatedAt: cacheUpdatedAt,
  };
  void browser.storage.local.set({ [KEYS.archiveOriginCache]: snapshot }).catch(() => {});
}

/** Mac base plus the fallback address and reader password currently in settings. */
export async function archiveAuthFor(macBase: string): Promise<ArchiveAuth> {
  const settings = await loadSettings();
  return { macBase, fallbackBase: settings.fallbackArchiveUrl, password: settings.readerPassword };
}

/**
 * True while the stored 401 fingerprint matches this password: the reader already
 * said no to it, and another call would only earn a browser login prompt.
 */
async function readerRejected(password: string): Promise<boolean> {
  if (!password.trim()) return false;
  try {
    const bag = await browser.storage.local.get(KEYS.readerAuthRejected);
    const stored = bag[KEYS.readerAuthRejected];
    if (typeof stored !== "string" || !stored) return false;
    return readerAuthStillRejected(stored, await passwordFingerprint(password));
  } catch {
    return false;
  }
}

export interface ReadingList {
  totalUsable: number;
  sources: Array<{ site: string; count: number; latest: string }>;
  articles: ArchiveArticleMeta[];
  /** Base the articles were read from. Text loads and permalinks stay on it. */
  originBase: string;
}

export async function loadReadingList(args: {
  macBase: string;
  sinceDays: number;
  limit: number;
  signal?: AbortSignal;
  auth?: ArchiveAuth;
  /** When set, the shared cache is left alone. Tests pass their own. */
  cache?: OriginCache;
  fetchImpl?: typeof fetch;
}): Promise<ReadingList> {
  const macBase = normalizeArchiveUrl(args.macBase);
  if (!macBase) throw new Error("Invalid archive URL");
  const auth = args.auth ?? (await archiveAuthFor(macBase));
  const cache = args.cache ?? sharedCache;
  if (!args.cache) await refreshSharedCache();
  const won: RaceSuccess = await raceArchiveJson({
    macBase,
    fallbackBase: fallbackBaseOf(auth.fallbackBase),
    password: auth.password,
    readerRejected: await readerRejected(auth.password),
    path: `/api/snapshots?since_days=${args.sinceDays}&limit=${args.limit}`,
    timeoutMs: LIST_TIMEOUT_MS,
    signal: args.signal,
    cache,
    fetchImpl: args.fetchImpl,
    onCache: args.cache ? undefined : persistSharedCache,
  });
  const parsed = parseSnapshotList(won.base, won.json);
  if (!parsed) throw new Error(`archive responded 200 for ${won.base}/api/snapshots but the list was not usable`);
  return { ...parsed, originBase: won.base };
}

export async function loadReadingArticles(args: {
  macBase: string;
  auth: ArchiveAuth;
  ids: string[];
  signal?: AbortSignal;
  /**
   * Text for a list already on screen. Fetched directly, including when a late
   * Mac answer has since marked the cache up.
   */
  pinnedBase?: string | null;
  cache?: OriginCache;
  fetchImpl?: typeof fetch;
}): Promise<{
  articles: ArchiveArticle[];
  failed: Array<{ id: string; reason: string }>;
  originBase: string | null;
}> {
  const macBase = normalizeArchiveUrl(args.macBase);
  if (!macBase) throw new Error("Invalid archive URL");
  const auth: ArchiveAuth = { ...args.auth, macBase };
  if (args.pinnedBase) {
    const got = await createArchiveBridge(args.pinnedBase, auth).getArticles({ ids: args.ids, signal: args.signal });
    return { ...got, originBase: args.pinnedBase };
  }
  const articles: ArchiveArticle[] = [];
  const failed: Array<{ id: string; reason: string }> = [];
  let originBase: string | null = null;
  const cache = args.cache ?? sharedCache;
  if (!args.cache) await refreshSharedCache();
  const rejected = await readerRejected(auth.password);
  for (const id of args.ids) {
    if (args.signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
    if (originBase) {
      const got = await createArchiveBridge(originBase, auth).getArticles({ ids: [id], signal: args.signal });
      articles.push(...got.articles);
      failed.push(...got.failed);
      continue;
    }
    try {
      const won = await raceArchiveJson({
        macBase,
        fallbackBase: fallbackBaseOf(auth.fallbackBase),
        password: auth.password,
        readerRejected: rejected,
        path: `/api/snapshots/${encodeURIComponent(id)}/text`,
        timeoutMs: TEXT_TIMEOUT_MS,
        signal: args.signal,
        cache,
        fetchImpl: args.fetchImpl,
        onCache: args.cache ? undefined : persistSharedCache,
      });
      const article = parseSnapshotArticle(won.base, won.json);
      if (!article) {
        failed.push({ id, reason: `archive responded 200 for ${won.base}/api/snapshots/${id}/text` });
        continue;
      }
      originBase = won.base;
      articles.push(article);
    } catch (err) {
      if (args.signal?.aborted) throw err;
      failed.push({ id, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return { articles, failed, originBase };
}

/**
 * Archive reads for one build. The list pins the origin; article text stays on
 * that origin even if the Mac answers late and the cache flips to up.
 * Gifts and saves are not on this bridge: the Mac is the only writer.
 */
export function createFailoverArchiveBridge(macBase: string, auth: ArchiveAuth): ArchiveBridge {
  let pinned: string | null = null;
  return {
    async listArticles({ sinceDays, limit }) {
      const listed = await loadReadingList({ macBase, sinceDays, limit, auth });
      pinned = listed.originBase;
      return listed;
    },
    async getArticles({ ids }) {
      const result = await loadReadingArticles({ macBase, auth, ids, pinnedBase: pinned });
      if (!pinned && result.originBase) pinned = result.originBase;
      return result;
    },
  };
}
