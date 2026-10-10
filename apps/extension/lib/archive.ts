import type { ArchiveArticle, ArchiveArticleMeta, ArchiveBridge } from "@homepage/agent-core";

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

async function getJson<T>(url: string, timeoutMs: number): Promise<T> {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`archive responded ${response.status} for ${url}`);
  return (await response.json()) as T;
}

/**
 * The user's Amber archive over its local JSON API. Used by the service worker
 * (the build) and by the new-tab page (the library and reader), so both see the
 * same shape.
 */
export function createArchiveBridge(archiveUrl: string): ArchiveBridge {
  const base = archiveUrl.trim().replace(/\/+$/, "");
  return {
    async listArticles({ sinceDays, limit }) {
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

    async getArticles({ ids }) {
      const articles: ArchiveArticle[] = [];
      const failed: Array<{ id: string; reason: string }> = [];
      await Promise.all(
        ids.map(async (id) => {
          try {
            const body = await getJson<ApiText>(
              `${base}/api/snapshots/${encodeURIComponent(id)}/text`,
              TEXT_TIMEOUT_MS,
            );
            articles.push({ ...toMeta(base, body), text: body.text });
          } catch (err) {
            failed.push({ id, reason: String(err) });
          }
        }),
      );
      return { articles, failed };
    },
  };
}
