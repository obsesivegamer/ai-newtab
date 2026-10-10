/**
 * Contracts shared by every host that can drive the homepage agent.
 *
 * The orchestrator is deliberately ignorant of *where* it runs. The extension
 * supplies a bridge backed by `chrome.history` / `chrome.tabs`; the Node test
 * harness supplies one backed by fixtures and `fetch`. Nothing in this package
 * may import `chrome`, `browser`, or `node:*`.
 */

/** One domain's worth of browsing history, narrowed to fit in a context window. */
export interface SiteDigest {
  domain: string;
  visits: number;
  pages: number;
  /** ISO 8601 — the model reasons about dates, not epoch milliseconds. */
  lastVisit: string;
  score: number;
  /** Capped. `urls[]` is dropped entirely. */
  sampleTitles: string[];
}

export interface GetHistoryResult {
  windowDays: number;
  /** What the model is *not* seeing. Without this it assumes the digest is exhaustive. */
  totalSitesSeen: number;
  sites: SiteDigest[];
}

/** A page whose HTML now lives in the session sandbox rather than in context. */
export interface PageRef {
  url: string;
  title: string;
  /**
   * The path the sandbox actually resolved, read back off the `resources.add()`
   * response. Never the path we asked for — the API re-roots every file resource
   * under `/mnt/session/uploads/`, so a requested `/workspace/x.html` lands at
   * `/mnt/session/uploads/workspace/x.html`.
   */
  mountPath: string;
  /** Lets the model choose grep-first over read-whole. */
  bytes: number;
}

export interface GetPageHtmlResult {
  pages: PageRef[];
  /** Surfaced, never swallowed: partial failure is information the model needs. */
  failed: Array<{ url: string; reason: string }>;
}

/** Raw per-domain history, as a BrowserBridge returns it — before `buildHistoryDigest` narrows it. */
export interface RawSiteMetadata {
  domain: string;
  totalVisits: number;
  uniquePages: number;
  lastVisitTime: number;
  averageVisitsPerDay: number;
  titles: string[];
  urls: string[];
  relevanceScore: number;
}

export interface ScrapedPage {
  url: string;
  /** Where the page ended up after redirects, when the host can tell. */
  finalUrl?: string;
  title: string;
  html: string;
}

/**
 * The two capabilities only a real browser has. Everything else the agent needs
 * (a filesystem, grep, read) is supplied by the session sandbox.
 */
export interface BrowserBridge {
  getHistory(args: {
    daysToAnalyze: number;
    maxResults: number;
  }): Promise<{ sites: RawSiteMetadata[]; totalSitesSeen: number }>;

  getPageHtml(args: {
    urls: string[];
    loadDelayMs?: number;
  }): Promise<{ pages: ScrapedPage[]; failed: Array<{ url: string; reason: string }> }>;
}

/** One saved article in the user's personal archive (Amber), without its body. */
export interface ArchiveArticleMeta {
  id: string;
  title: string;
  /** Display name of the publication, e.g. "Financial Times". */
  site: string;
  author?: string;
  /** ISO 8601, when the publisher says it ran. Often absent. */
  publishedAt?: string;
  /** ISO 8601, when the user saved it. */
  savedAt: string;
  wordCount: number;
  paywalled: boolean;
  /** The publisher's URL, as saved. */
  originalUrl: string;
  /** Stable archive link that reads without a paywall. This is the link to put on the page. */
  permalink: string;
}

export interface ArchiveArticle extends ArchiveArticleMeta {
  /** Plain-text article body. */
  text: string;
}

/** What `getArchive` returns to the model. */
export interface GetArchiveResult {
  windowDays: number;
  /** Usable archived articles in the window, before `articles` was capped. */
  totalUsable: number;
  /** Per-publication counts over the whole window, not just `articles`. */
  sources: Array<{ site: string; count: number; latest: string }>;
  articles: ArchiveArticleMeta[];
}

/** An archived article whose text now lives in the session sandbox. */
export interface ArchiveRef {
  id: string;
  title: string;
  site: string;
  permalink: string;
  originalUrl: string;
  /** What `resources.add()` resolved, never the path asked for. */
  mountPath: string;
  /** Size of the mounted file, which may be a truncated copy. */
  bytes: number;
  /** Words in the full article, not in the mounted file. */
  wordCount: number;
  /** The mounted file stops early and ends with a pointer to the full text. */
  truncated: boolean;
}

export interface GetArchiveArticlesResult {
  articles: ArchiveRef[];
  failed: Array<{ id: string; reason: string }>;
}

/**
 * The user's personal article archive. Host-supplied like BrowserBridge: the
 * extension and the Bun harness both implement it over `fetch`. Optional on the
 * orchestrator — a build without one just has no archive tools to answer.
 */
export interface ArchiveBridge {
  listArticles(args: { sinceDays: number; limit: number }): Promise<{
    totalUsable: number;
    sources: GetArchiveResult["sources"];
    articles: ArchiveArticleMeta[];
  }>;
  getArticles(args: { ids: string[] }): Promise<{
    articles: ArchiveArticle[];
    failed: Array<{ id: string; reason: string }>;
  }>;
}

/** A publication the user reads, with the feeds that list its newest articles. */
export interface FeedSource {
  id: string;
  /** Display name, e.g. "Financial Times". Matches the archive's `site` where they overlap. */
  name: string;
  feedUrls: string[];
  enabled: boolean;
}

/** One current article from a source's feed. */
export interface FeedItem {
  /** Stable hash of the canonical link. */
  id: string;
  title: string;
  /** The publisher's article URL. */
  link: string;
  /** Source display name. */
  source: string;
  /** ISO 8601 when the feed gave a parseable date. */
  publishedAt?: string;
  summary?: string;
  author?: string;
  section?: string;
}

export interface FeedSourceStatus {
  name: string;
  count: number;
  /** Set when the feed could not be fetched or parsed. */
  error?: string;
}

/** What `getFeeds` returns to the model. */
export interface GetFeedsResult {
  fetchedAt: string;
  sources: FeedSourceStatus[];
  items: FeedItem[];
}

/**
 * The user's sources' newest articles. Host-supplied (the extension fetches the
 * feeds from the browser). Optional on the orchestrator.
 */
export interface FeedBridge {
  fetchLatest(args: { sinceHours: number; perSource: number }): Promise<{
    items: FeedItem[];
    sources: FeedSourceStatus[];
  }>;
}

/** Minimal persistence. `chrome.storage.local` in the extension, a JSON file in Node. */
export interface KVStore {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
}

export type RunPhase =
  | "setup"
  | "session-create"
  | "thinking"
  | "history"
  | "scraping"
  | "analyzing"
  | "writing"
  | "cleanup"
  | "done"
  | "error";

export interface RunCallbacks {
  onPhase?(phase: RunPhase, detail?: string): void;
  /** Streamed assistant prose, for a progress panel. */
  onText?(text: string): void;
  onLog?(line: string): void;
}

export interface HomepageBuildResult {
  code: string;
  sessionId: string;
  /** Where the code came from: a session output file, or a fenced block in the final message. */
  source: "session-output" | "message-fence";
}
