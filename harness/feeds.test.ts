import { afterEach, describe, expect, test } from "bun:test";
import { DEFAULT_FEEDS, fetchSourceFeeds, migrateRetiredFeeds, parseFeed, type FeedSource } from "@homepage/agent-core";

/** The section feeds shipped before `feeds.washingtonpost.com` started answering 502. */
const DEAD_WAPO = [
  "https://feeds.washingtonpost.com/rss/national",
  "https://feeds.washingtonpost.com/rss/world",
  "https://feeds.washingtonpost.com/rss/business",
  "https://feeds.washingtonpost.com/rss/politics",
];

const ARC_WAPO = [
  "https://www.washingtonpost.com/arcio/rss/category/national/",
  "https://www.washingtonpost.com/arcio/rss/category/world/",
  "https://www.washingtonpost.com/arcio/rss/category/business/",
  "https://www.washingtonpost.com/arcio/rss/category/politics/",
];

/** One item in the shape the Post's Arc RSS returned on 2026-10-20. */
const ARC_ITEM = `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">
<channel><title>World</title>
<item><title>Alberta rejects a move toward independence from Canada in a victory for Carney</title><link>https://www.washingtonpost.com/world/2026/10/20/alberta-canada-referendum-indepence-carney/c86a8ac8-cc3c-11f1-ac04-9f58578a68b4_story.html</link><guid isPermaLink="true">https://www.washingtonpost.com/world/2026/10/20/alberta-canada-referendum-indepence-carney/c86a8ac8-cc3c-11f1-ac04-9f58578a68b4_story.html</guid><dc:creator>Rob Gillies | AP</dc:creator><pubDate>Tue, 20 Oct 2026 15:06:10 +0000</pubDate><description>Voters in Alberta have overwhelmingly backed remaining in Canada.</description></item>
</channel></rss>`;

const source = (id: string, name: string, feedUrls: string[]): FeedSource => ({ id, name, feedUrls, enabled: true });

describe("Washington Post feeds", () => {
  test("the default catalog uses the Arc section feeds", () => {
    const wapo = DEFAULT_FEEDS.find((k) => k.id === "wapo");
    expect(wapo?.feeds).toEqual(ARC_WAPO);
    expect(wapo?.feeds.some((url) => url.includes("feeds.washingtonpost.com"))).toBe(false);
  });

  test("a stored catalog still on feeds.washingtonpost.com is migrated, and other sources are not", () => {
    const ft = source("ft", "Financial Times", ["https://www.ft.com/rss/home", "https://www.ft.com/world?format=rss"]);
    const nyt = source("nyt", "The New York Times", ["https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml"]);
    const wapo = source("wapo", "The Washington Post", DEAD_WAPO);
    const { sources, changed } = migrateRetiredFeeds([ft, nyt, wapo]);
    expect(changed).toBe(true);
    expect(sources.find((s) => s.id === "ft")).toEqual(ft);
    expect(sources.find((s) => s.id === "nyt")).toEqual(nyt);
    expect(sources.find((s) => s.id === "wapo")?.feedUrls).toEqual(ARC_WAPO);
  });

  test("an edited Washington Post list is left alone", () => {
    const custom = source("wapo", "The Washington Post", ["https://www.washingtonpost.com/arcio/rss/author/Carolyn-Hax/"]);
    const { sources, changed } = migrateRetiredFeeds([custom]);
    expect(changed).toBe(false);
    expect(sources).toEqual([custom]);
  });

  test("WSJ's retired feed still migrates", () => {
    const wsj = source("wsj", "The Wall Street Journal", ["https://feeds.a.dj.com/rss/RSSWorldNews.xml"]);
    const { sources, changed } = migrateRetiredFeeds([wsj]);
    expect(changed).toBe(true);
    expect(sources[0]?.feedUrls).toEqual(DEFAULT_FEEDS.find((k) => k.id === "wsj")!.feeds);
  });

  test("an Arc item parses to a washingtonpost.com story", () => {
    const items = parseFeed(ARC_ITEM, "The Washington Post");
    expect(items).toHaveLength(1);
    expect(items[0]?.title).toBe("Alberta rejects a move toward independence from Canada in a victory for Carney");
    expect(items[0]?.link).toBe(
      "https://www.washingtonpost.com/world/2026/10/20/alberta-canada-referendum-indepence-carney/c86a8ac8-cc3c-11f1-ac04-9f58578a68b4_story.html",
    );
    expect(items[0]?.source).toBe("The Washington Post");
    expect(items[0]?.author).toBe("Rob Gillies | AP");
    expect(items[0]?.publishedAt).toBe("2026-10-20T15:06:10.000Z");
  });
});

describe("fetchSourceFeeds", () => {
  const original = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = original;
  });

  /** Bun's `fetch` type also carries `preconnect`, which a test double does not. */
  const stubFetch = (impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) => {
    globalThis.fetch = impl as unknown as typeof fetch;
  };

  test("a source whose every feed answers 502 reports an error and no items", async () => {
    stubFetch(async () =>
      new Response("<html><head><title>502 Bad Gateway</title></head><body><h1>502 Bad Gateway</h1></body></html>", {
        status: 502,
        headers: { "content-type": "text/html" },
      }),
    );
    const result = await fetchSourceFeeds(source("wapo", "The Washington Post", DEAD_WAPO), {
      sinceHours: 36,
      perSource: 20,
    });
    expect(result.done).toBe(true);
    expect(result.items).toEqual([]);
    expect(result.error).toContain("HTTP 502");
  });

  test("a feed that returns RSS still yields items", async () => {
    stubFetch(async () => new Response(ARC_ITEM, { status: 200, headers: { "content-type": "text/xml; charset=utf-8" } }));
    const guardian = source("guardian", "The Guardian", ["https://www.theguardian.com/world/rss"]);
    const result = await fetchSourceFeeds(guardian, { sinceHours: 48, perSource: 20, now: Date.parse("2026-10-20T16:00:00Z") });
    expect(result.error).toBeUndefined();
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.source).toBe("The Guardian");
  });

  test("one dead feed does not drop stories from a feed that answered", async () => {
    stubFetch(async (input) => {
      const url = String(input);
      if (url.includes("feeds.washingtonpost.com")) {
        return new Response("bad gateway", { status: 502, headers: { "content-type": "text/html" } });
      }
      return new Response(ARC_ITEM, { status: 200, headers: { "content-type": "text/xml; charset=utf-8" } });
    });
    const result = await fetchSourceFeeds(
      source("wapo", "The Washington Post", [DEAD_WAPO[0]!, ARC_WAPO[0]!]),
      { sinceHours: 48, perSource: 20, now: Date.parse("2026-10-20T16:00:00Z") },
    );
    expect(result.items).toHaveLength(1);
    expect(result.error).toContain("1 of 2 feeds failed");
    expect(result.error).toContain("HTTP 502");
  });
});
