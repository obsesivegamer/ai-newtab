/**
 * A BrowserBridge backed by fixtures + fetch, for verifying the agent pipeline
 * outside Chrome. The extension supplies the real one (chrome.history / tabs).
 *
 * This is a test harness, not a fallback: it cannot see authenticated or
 * JS-rendered pages, which is the entire reason getPageHtml runs in the user's
 * browser in production.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_BLOCKED_SITES,
  archiveHostOf,
  normalizeArchiveUrl,
  type ArchiveArticle,
  type ArchiveArticleMeta,
  type ArchiveBridge,
  type BrowserBridge,
  type KVStore,
  type RawSiteMetadata,
} from "@homepage/agent-core";

/** Harness state (cached agent/environment IDs, active session) and output, next to these scripts. */
export const STATE_PATH = join(import.meta.dir, ".agent-state.json");
export const OUT_DIR = join(import.meta.dir, "out");
export const OUT_PATH = join(OUT_DIR, "homepage.tsx");

export class FileKVStore implements KVStore {
  constructor(private readonly path: string) {}

  private read(): Record<string, unknown> {
    if (!existsSync(this.path)) return {};
    try {
      return JSON.parse(readFileSync(this.path, "utf-8"));
    } catch {
      return {};
    }
  }

  async get<T>(key: string): Promise<T | undefined> {
    return this.read()[key] as T | undefined;
  }

  async set(key: string, value: unknown): Promise<void> {
    const data = this.read();
    data[key] = value;
    writeFileSync(this.path, JSON.stringify(data, null, 2));
  }

  async remove(key: string): Promise<void> {
    const data = this.read();
    delete data[key];
    writeFileSync(this.path, JSON.stringify(data, null, 2));
  }
}

const DAY = 24 * 60 * 60 * 1000;

/** Stand-in for what the extension's lib/history.ts produces from chrome.history. */
export function fixtureHistory(now = Date.now()): RawSiteMetadata[] {
  const make = (
    domain: string,
    totalVisits: number,
    uniquePages: number,
    hoursAgo: number,
    titles: string[],
    score: number,
  ): RawSiteMetadata => ({
    domain,
    totalVisits,
    uniquePages,
    lastVisitTime: now - hoursAgo * 60 * 60 * 1000,
    averageVisitsPerDay: totalVisits / 14,
    titles,
    urls: titles.map((_, i) => `https://${domain}/item/${i}`),
    relevanceScore: score,
  });

  return [
    make("news.ycombinator.com", 142, 63, 1, ["Hacker News", "Show HN: a thing", "Ask HN: how do you"], 0.94),
    make("lobste.rs", 58, 24, 3, ["Lobsters", "Rust in the kernel"], 0.81),
    make("arstechnica.com", 44, 31, 6, ["Ars Technica", "Space policy roundup"], 0.72),
    make("github.com", 210, 96, 0.5, ["GitHub", "pull requests", "issues"], 0.69),
    make("mail.google.com", 300, 4, 0.2, ["Inbox (12)"], 0.66),
    make("stackoverflow.com", 33, 30, 26, ["How to center a div"], 0.41),
    make("en.wikipedia.org", 21, 19, 50, ["Cache coherence", "Byzantine fault"], 0.33),
    ...Array.from({ length: 40 }, (_, i) =>
      make(`filler-${i}.example.com`, 3, 2, 100 + i, [`Filler ${i}`], 0.2 - i * 0.001),
    ),
  ];
}

/** Crude sanitizer approximating the extension's cleanHtmlForLLM (lib/scraper.ts). */
function cleanHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<svg[\s\S]*?<\/svg>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\son\w+="[^"]*"/gi, "")
    .replace(/\n{3,}/g, "\n\n");
}

function titleOf(html: string, url: string): string {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? m[1].trim().slice(0, 200) : url;
}

export const nodeBridge: BrowserBridge = {
  async getHistory() {
    const sites = fixtureHistory();
    return { sites, totalSitesSeen: sites.length };
  },

  async getPageHtml({ urls }) {
    const pages: Array<{ url: string; title: string; html: string }> = [];
    const failed: Array<{ url: string; reason: string }> = [];

    await Promise.all(
      urls.map(async (url) => {
        try {
          const res = await fetch(url, {
            headers: { "user-agent": "Mozilla/5.0 (homepage-agent-harness)" },
            signal: AbortSignal.timeout(20_000),
          });
          if (!res.ok) {
            failed.push({ url, reason: `HTTP ${res.status}` });
            return;
          }
          const raw = await res.text();
          pages.push({ url, title: titleOf(raw, url), html: cleanHtml(raw) });
        } catch (err) {
          failed.push({ url, reason: String(err) });
        }
      }),
    );

    return { pages, failed };
  },
};

/**
 * The Amber archive over its JSON API, for the harness. Mirrors the extension's
 * lib/archive.ts mapping on purpose rather than importing it: the harness must
 * not depend on the extension workspace. Address cleanup is shared through
 * agent-core's `normalizeArchiveUrl`.
 */
export const DEFAULT_AMBER_URL = "http://127.0.0.1:8080";

interface AmberSnapshot {
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

export function createNodeArchiveBridge(baseUrl = DEFAULT_AMBER_URL): ArchiveBridge {
  const base = normalizeArchiveUrl(baseUrl);
  if (!base) throw new Error(`Invalid archive URL: ${baseUrl}`);

  const getJson = async <T>(path: string, timeoutMs: number): Promise<T> => {
    const res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`archive responded ${res.status} for ${path}`);
    return (await res.json()) as T;
  };

  const toMeta = (s: AmberSnapshot): ArchiveArticleMeta => ({
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
  });

  return {
    async listArticles({ sinceDays, limit }) {
      const list = await getJson<{
        total_usable: number;
        sources: Array<{ site: string; count: number; latest: string }>;
        snapshots: AmberSnapshot[];
      }>(`/api/snapshots?since_days=${sinceDays}&limit=${limit}`, 10_000);
      return {
        totalUsable: list.total_usable,
        sources: list.sources,
        articles: list.snapshots.map(toMeta),
      };
    },

    async getArticles({ ids }) {
      const articles: ArchiveArticle[] = [];
      const failed: Array<{ id: string; reason: string }> = [];
      await Promise.all(
        ids.map(async (id) => {
          try {
            const body = await getJson<AmberSnapshot & { text: string }>(
              `/api/snapshots/${encodeURIComponent(id)}/text`,
              20_000,
            );
            articles.push({ ...toMeta(body), text: body.text });
          } catch (err) {
            failed.push({ id, reason: String(err) });
          }
        }),
      );
      return { articles, failed };
    },
  };
}

function harnessArchiveUrl(): string {
  return (process.env.AMBER_URL ?? DEFAULT_AMBER_URL).trim();
}

/** The harness's archive: `AMBER_URL` if set (empty string turns it off), else the local default. */
export function harnessArchive(): ArchiveBridge | undefined {
  const url = harnessArchiveUrl();
  if (!url) return undefined;
  if (!normalizeArchiveUrl(url)) {
    console.warn("[harness] AMBER_URL is not a valid http(s) address; running without the archive");
    return undefined;
  }
  return createNodeArchiveBridge(url);
}

/**
 * The default blocked sites plus the archive's own host, as the extension's
 * build-manager does: the archive index lists every saved article, so
 * getPageHtml must never be pointed at it.
 */
export function harnessBlockedSites(): string[] {
  const host = archiveHostOf(harnessArchiveUrl());
  return [...DEFAULT_BLOCKED_SITES, ...(host ? [host] : [])];
}
