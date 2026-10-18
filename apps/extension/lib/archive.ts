import {
  anySignal,
  normalizeArchiveUrl,
  type ArchiveArticle,
  type ArchiveArticleMeta,
  type ArchiveBridge,
} from "@homepage/agent-core";

export const DEFAULT_ARCHIVE_URL = "http://127.0.0.1:8080";

const LIST_TIMEOUT_MS = 10_000;
const TEXT_TIMEOUT_MS = 20_000;

interface ApiSnapshot {
  id: string;
  url: string;
  final_url: string | null;
  title: string;
  site: string;
  author: string | null;
  published_at: string | null;
  created_at: string;
  word_count: number;
  paywalled: boolean;
}

interface ApiList {
  total_usable: number;
  sources: Array<{ site: string; count: number; latest: string }>;
  snapshots: ApiSnapshot[];
}

type ApiText = ApiSnapshot & { text: string };

/** One gift link waiting in Amber. Status is derived by Amber on each read. */
export interface GiftCandidate {
  id: string;
  unlockUrl: string;
  /** The article's own address, when the find included one. Absent when unknown. */
  canonicalUrl?: string;
  /** Publication display name, e.g. "The New York Times". */
  site: string;
  publisher: string;
  title: string;
  sourceUrl?: string;
  sourceAuthor?: string;
  /** ISO 8601, when the gift was found. */
  foundAt: string;
  expiresAt?: string;
  expiresEstimated: boolean;
  status: string;
  /** Set when a usable snapshot already matches this gift. */
  archivedId?: string;
}

interface ApiCandidate {
  id?: unknown;
  unlock_url?: unknown;
  canonical_url?: unknown;
  site?: unknown;
  publisher?: unknown;
  title?: unknown;
  source_url?: unknown;
  source_author?: unknown;
  found_at?: unknown;
  expires_at?: unknown;
  expires_estimated?: unknown;
  status?: unknown;
  archived?: { id?: unknown; usable?: unknown } | null;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function toCandidate(raw: ApiCandidate): GiftCandidate | null {
  const id = text(raw?.id);
  const unlockUrl = text(raw?.unlock_url);
  if (!id || !unlockUrl) return null;
  const archived = raw?.archived;
  const archivedId =
    archived && typeof archived === "object" && archived.usable !== false ? text(archived.id) : undefined;
  return {
    id,
    unlockUrl,
    canonicalUrl: text(raw.canonical_url),
    site: text(raw.site) ?? "",
    publisher: text(raw.publisher) ?? "",
    title: text(raw.title) ?? "",
    sourceUrl: text(raw.source_url),
    sourceAuthor: text(raw.source_author),
    foundAt: text(raw.found_at) ?? "",
    expiresAt: text(raw.expires_at),
    expiresEstimated: raw.expires_estimated === true,
    status: text(raw.status) ?? "new",
    archivedId,
  };
}

function toMeta(base: string, s: ApiSnapshot): ArchiveArticleMeta {
  return {
    id: s.id,
    title: s.title,
    site: s.site,
    author: s.author ?? undefined,
    publishedAt: s.published_at ?? undefined,
    savedAt: s.created_at,
    wordCount: s.word_count,
    paywalled: s.paywalled,
    originalUrl: s.final_url ?? s.url,
    permalink: `${base}/${s.id}`,
  };
}

async function getJson<T>(url: string, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const response = await fetch(url, { signal: signal ? anySignal([timeout, signal]) : timeout });
  if (!response.ok) throw new Error(`archive responded ${response.status} for ${url}`);
  return (await response.json()) as T;
}

/** The bridge the new-tab page uses: `getArticles` can be cancelled by the caller. */
export type CancellableArchiveBridge = Omit<ArchiveBridge, "getArticles"> & {
  getArticles(args: {
    ids: string[];
    signal?: AbortSignal;
  }): ReturnType<ArchiveBridge["getArticles"]>;
  /** The live gift queue (`GET /api/candidates`). Empty when Amber has none. */
  listCandidates(args?: { signal?: AbortSignal }): Promise<GiftCandidate[]>;
};

/**
 * The user's Amber archive over its local JSON API. Used by the service worker
 * (the build) and by the new-tab page (the library, the reader and the gift
 * queue), so both see the same shape. This bridge is still the only loopback
 * client: gifts are another read of the same Amber, not a new way to reach it.
 */
export function createArchiveBridge(archiveUrl: string): CancellableArchiveBridge {
  const normalized = normalizeArchiveUrl(archiveUrl);
  // Rejected from the methods, not here, so callers that build the bridge inside an
  // effect get a rejected promise they already handle rather than a throw.
  const need = (): string => {
    if (normalized === null) throw new Error("Invalid archive URL");
    return normalized;
  };
  return {
    async listArticles({ sinceDays, limit }) {
      const base = need();
      const list = await getJson<ApiList>(
        `${base}/api/snapshots?since_days=${sinceDays}&limit=${limit}`,
        LIST_TIMEOUT_MS,
      );
      return {
        totalUsable: list.total_usable,
        sources: list.sources,
        articles: list.snapshots.map((s) => toMeta(base, s)),
      };
    },

    async getArticles({ ids, signal }) {
      const base = need();
      const articles: ArchiveArticle[] = [];
      const failed: Array<{ id: string; reason: string }> = [];
      await Promise.all(
        ids.map(async (id) => {
          try {
            const body = await getJson<ApiText>(
              `${base}/api/snapshots/${encodeURIComponent(id)}/text`,
              TEXT_TIMEOUT_MS,
              signal,
            );
            articles.push({ ...toMeta(base, body), text: body.text });
          } catch (err) {
            failed.push({ id, reason: String(err) });
          }
        }),
      );
      return { articles, failed };
    },

    async listCandidates({ signal } = {}) {
      const base = need();
      const list = await getJson<{ candidates?: ApiCandidate[] }>(`${base}/api/candidates`, LIST_TIMEOUT_MS, signal);
      if (!Array.isArray(list.candidates)) return [];
      return list.candidates.flatMap((row) => {
        const candidate = toCandidate(row);
        return candidate ? [candidate] : [];
      });
    },
  };
}
