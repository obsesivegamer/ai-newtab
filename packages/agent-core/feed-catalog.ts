import type { FeedSource } from "./types";
import { hostOf, isSameOrSubdomain } from "./site-filter";

/**
 * The user's catalog of news sources: which publications they read and the
 * feeds that list each one's newest articles. Seeded from the Amber archive's
 * `sources` (and Chrome history), then editable in Settings.
 */
export interface KnownSource {
  id: string;
  /** Matches the archive's normalized `site` names. */
  name: string;
  /** Other spellings of the name an archive or a person might use. */
  aliases: string[];
  hosts: string[];
  feeds: string[];
}

/** Publications we know feeds for. Verified to answer with items on 2026-10-10. */
export const DEFAULT_FEEDS: readonly KnownSource[] = [
  {
    id: "ft",
    name: "Financial Times",
    aliases: ["FT", "FT.com"],
    hosts: ["ft.com"],
    feeds: ["https://www.ft.com/rss/home", "https://www.ft.com/world?format=rss"],
  },
  {
    id: "nyt",
    name: "The New York Times",
    aliases: ["NYT", "New York Times", "nytimes.com"],
    hosts: ["nytimes.com"],
    feeds: [
      "https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml",
      "https://rss.nytimes.com/services/xml/rss/nyt/World.xml",
      "https://rss.nytimes.com/services/xml/rss/nyt/Business.xml",
      "https://rss.nytimes.com/services/xml/rss/nyt/Technology.xml",
      "https://rss.nytimes.com/services/xml/rss/nyt/Politics.xml",
    ],
  },
  {
    id: "wapo",
    name: "The Washington Post",
    aliases: ["WaPo", "Washington Post", "washingtonpost.com"],
    hosts: ["washingtonpost.com"],
    feeds: [
      "https://feeds.washingtonpost.com/rss/national",
      "https://feeds.washingtonpost.com/rss/world",
      "https://feeds.washingtonpost.com/rss/business",
      "https://feeds.washingtonpost.com/rss/politics",
    ],
  },
  {
    id: "newyorker",
    name: "The New Yorker",
    aliases: ["New Yorker", "newyorker.com"],
    hosts: ["newyorker.com"],
    feeds: ["https://www.newyorker.com/feed/everything"],
  },
  {
    id: "politico",
    name: "POLITICO",
    aliases: ["Politico", "politico.com"],
    hosts: ["politico.com", "politico.eu"],
    feeds: ["https://rss.politico.com/politics-news.xml"],
  },
  {
    id: "atlantic",
    name: "The Atlantic",
    aliases: ["Atlantic", "theatlantic.com"],
    hosts: ["theatlantic.com"],
    feeds: ["https://www.theatlantic.com/feed/all/"],
  },
  {
    id: "wsj",
    name: "The Wall Street Journal",
    aliases: ["WSJ", "Wall Street Journal", "wsj.com"],
    hosts: ["wsj.com"],
    feeds: ["https://feeds.a.dj.com/rss/RSSWorldNews.xml"],
  },
  {
    id: "guardian",
    name: "The Guardian",
    aliases: ["Guardian", "theguardian.com"],
    hosts: ["theguardian.com", "guardian.co.uk"],
    feeds: ["https://www.theguardian.com/world/rss", "https://www.theguardian.com/us-news/rss"],
  },
  {
    id: "ars-technica",
    name: "Ars Technica",
    aliases: ["arstechnica.com"],
    hosts: ["arstechnica.com"],
    feeds: ["https://feeds.arstechnica.com/arstechnica/index"],
  },
  {
    id: "intercept",
    name: "The Intercept",
    aliases: ["Intercept", "theintercept.com"],
    hosts: ["theintercept.com"],
    feeds: ["https://theintercept.com/feed/?rss"],
  },
  {
    id: "bbc",
    name: "BBC News",
    aliases: ["BBC", "bbc.com", "bbc.co.uk"],
    hosts: ["bbc.com", "bbc.co.uk"],
    feeds: ["https://feeds.bbci.co.uk/news/world/rss.xml"],
  },
  {
    id: "npr",
    name: "NPR",
    aliases: ["npr.org"],
    hosts: ["npr.org"],
    feeds: ["https://feeds.npr.org/1001/rss.xml"],
  },
  {
    id: "bloomberg",
    name: "Bloomberg",
    aliases: ["bloomberg.com"],
    hosts: ["bloomberg.com"],
    feeds: ["https://feeds.bloomberg.com/politics/news.rss"],
  },
  {
    id: "cbc",
    name: "CBC News",
    aliases: ["CBC", "cbc.ca"],
    hosts: ["cbc.ca"],
    feeds: ["https://www.cbc.ca/webfeed/rss/rss-topstories"],
  },
  {
    id: "hacker-news",
    name: "Hacker News",
    aliases: ["HN", "news.ycombinator.com"],
    hosts: ["news.ycombinator.com"],
    feeds: ["https://news.ycombinator.com/rss"],
  },
  {
    id: "verge",
    name: "The Verge",
    aliases: ["Verge", "theverge.com"],
    hosts: ["theverge.com"],
    feeds: ["https://www.theverge.com/rss/index.xml"],
  },
  {
    id: "wired",
    name: "WIRED",
    aliases: ["Wired", "wired.com"],
    hosts: ["wired.com"],
    feeds: ["https://www.wired.com/feed/rss"],
  },
  {
    id: "techcrunch",
    name: "TechCrunch",
    aliases: ["techcrunch.com"],
    hosts: ["techcrunch.com"],
    feeds: ["https://techcrunch.com/feed/"],
  },
  {
    id: "axios",
    name: "Axios",
    aliases: ["axios.com"],
    hosts: ["axios.com"],
    feeds: ["https://api.axios.com/feed/"],
  },
];

/** "The New York Times", "nytimes.com" and "www.NYTimes.com" all reduce to comparable keys. */
function nameKey(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/^www\./, "")
    .replace(/\.(com|org|net|co\.uk|ca|eu|io)$/, "")
    .replace(/^the\s+/, "")
    .replace(/[^a-z0-9]+/g, "");
}

const BY_KEY = new Map<string, KnownSource>();
for (const known of DEFAULT_FEEDS) {
  for (const label of [known.name, ...known.aliases, ...known.hosts]) BY_KEY.set(nameKey(label), known);
}

/** The known publication for an archive `site` name or a bare host, if any. */
function knownByName(site: string): KnownSource | undefined {
  return BY_KEY.get(nameKey(site));
}

function knownByHost(domain: string): KnownSource | undefined {
  const host = hostOf(domain);
  if (!host) return undefined;
  return DEFAULT_FEEDS.find((k) => k.hosts.some((h) => isSameOrSubdomain(host, h)));
}

/**
 * True when a source should not be fetched because the blocked-sites list names
 * its publisher: one of its known hosts, or the host of one of its feed addresses.
 * Names are never read as hosts ("POLITICO" or "NPR" have no dot, and a dotless
 * name would look like a local-network host).
 */
export function isSourceBlocked(source: FeedSource, blocked: string[]): boolean {
  const known = DEFAULT_FEEDS.find((k) => k.id === source.id);
  const hosts = [...(known?.hosts ?? []), ...source.feedUrls.map((url) => hostOf(url))].filter(Boolean);
  return hosts.some((host) => isListed(host, blocked));
}

/** `isBlocked` minus its "private hosts are always blocked" rule: only what the list names. */
function isListed(host: string, list: string[]): boolean {
  return list.some((entry) => isSameOrSubdomain(host, entry.replace(/^\*\./, "")));
}

export const fromKnown = (k: KnownSource): FeedSource => ({
  id: k.id,
  name: k.name,
  feedUrls: [...k.feeds],
  enabled: true,
});

export interface SeedResult {
  sources: FeedSource[];
  /** Archive sites we have no feed for, so they could not be listed. */
  skipped: string[];
}


/**
 * The catalog for a reader: the archive's sources, most-saved first, then any
 * sites from browsing history that we know feeds for. Archive sites with no
 * known feed are reported in `skipped` rather than listed without a feed.
 */
export function seedCatalog(
  archiveSources: Array<{ site: string; count: number }>,
  historyDomains: string[] = [],
): SeedResult {
  const sources: FeedSource[] = [];
  const skipped: string[] = [];
  const have = new Set<string>();
  const add = (k: KnownSource) => {
    if (have.has(k.id)) return;
    have.add(k.id);
    sources.push(fromKnown(k));
  };

  const byCount = [...archiveSources].sort((a, b) => b.count - a.count);
  for (const { site } of byCount) {
    if (!site?.trim()) continue;
    const known = knownByName(site);
    if (known) add(known);
    else if (!skipped.includes(site)) skipped.push(site);
  }
  for (const domain of historyDomains) {
    const known = knownByHost(domain);
    if (known) add(known);
  }
  return { sources, skipped };
}

/** The catalog as `FeedSource[]`. See `seedCatalog` for what was left out. */
export function seedSources(
  archiveSources: Array<{ site: string; count: number }>,
  historyDomains?: string[],
): FeedSource[] {
  return seedCatalog(archiveSources, historyDomains).sources;
}


/** Adds sources from `seeded` that `current` doesn't already have; keeps everything else as the person left it. */
export function mergeSeeded(
  current: FeedSource[],
  seeded: FeedSource[],
): { sources: FeedSource[]; added: FeedSource[] } {
  const ids = new Set(current.map((s) => s.id));
  const added = seeded.filter((s) => !ids.has(s.id));
  return { sources: [...current, ...added], added };
}

/**
 * Adds a feed address to the list. A publication we know (by host) joins its
 * existing entry; anything else becomes its own source named after its host.
 */
export function addFeedUrl(current: FeedSource[], feedUrl: string): FeedSource[] {
  const host = hostOf(feedUrl);
  const known = host ? knownByHost(host) : undefined;
  const id = known ? known.id : `custom-${host || "feed"}`;
  const name = known ? known.name : host || feedUrl;
  const existing = current.find((s) => s.id === id);
  if (!existing) return [...current, { id, name, feedUrls: [feedUrl], enabled: true }];
  if (existing.feedUrls.includes(feedUrl)) return current;
  return current.map((s) => (s.id === id ? { ...s, feedUrls: [...s.feedUrls, feedUrl] } : s));
}

