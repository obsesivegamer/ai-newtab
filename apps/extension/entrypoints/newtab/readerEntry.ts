import type { ArchiveArticleMeta, FeedItem } from "@homepage/agent-core";
import { canonicalLink } from "@/lib/feeds";

/**
 * What the Reader can be opened on: a saved article (it has an `archiveId`) or
 * a story from outside the archive that Amber may be asked to fetch.
 */
export interface ReaderEntry {
  /** Unique within a list: the archive id, or a key built from the link. */
  key: string;
  title: string;
  site: string;
  author?: string;
  publishedAt?: string;
  /** The feed's blurb, shown at once while the full text is fetched. */
  summary?: string;
  /** The snapshot id, when the article is already in Amber. */
  archiveId?: string;
  /** The publisher's address. */
  url?: string;
  savedAt?: string;
  wordCount?: number;
  paywalled?: boolean;
  permalink?: string;
  /**
   * Whether opening may ask Amber to save it. True for a click on a list row;
   * false for a request from the model-built page, which must be confirmed
   * with a button first.
   */
  autoFetch: boolean;
}

export function entryFromArchive(meta: ArchiveArticleMeta): ReaderEntry {
  return {
    key: meta.id,
    title: meta.title,
    site: meta.site,
    author: meta.author,
    publishedAt: meta.publishedAt,
    archiveId: meta.id,
    url: meta.originalUrl,
    savedAt: meta.savedAt,
    wordCount: meta.wordCount,
    paywalled: meta.paywalled,
    permalink: meta.permalink,
    autoFetch: true,
  };
}

/** An archived article known only by its id (opened from the model-built page). */
export function entryFromId(id: string): ReaderEntry {
  return { key: id, title: "", site: "", archiveId: id, autoFetch: true };
}

/** A feed item, or the archive copy of it when Amber already has one. */
export function entryFromFeed(item: FeedItem, archived?: ArchiveArticleMeta): ReaderEntry {
  return {
    key: `feed:${item.id}`,
    title: item.title,
    site: item.source,
    author: item.author ?? archived?.author,
    publishedAt: item.publishedAt,
    summary: item.summary,
    archiveId: archived?.id,
    url: item.link,
    savedAt: archived?.savedAt,
    wordCount: archived?.wordCount,
    paywalled: archived?.paywalled,
    permalink: archived?.permalink,
    autoFetch: true,
  };
}

/** A bare address (from the model-built page): the host stands in for the title until the text arrives. */
export function entryFromUrl(href: string): ReaderEntry {
  const host = new URL(href).hostname.replace(/^www\./, "");
  return { key: `url:${articleKey(href)}`, title: host, site: host, url: href, autoFetch: false };
}

/**
 * The key the Latest list and the "In Amber" index use for an article address.
 * The model's links arrive percent-encoded (`'` as `%27`), the feed's may not be.
 */
export function articleKey(link: string): string {
  return canonicalLink(link).replace(/%27/gi, "'");
}
