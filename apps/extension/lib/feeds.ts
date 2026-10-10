import { canonicalLink, type FeedBridge, type FeedItem, type FeedSource, type FeedSourceStatus } from "@homepage/agent-core";

/** The one definition lives in agent-core, where the `getFeeds` handler uses it to match archived stories. */
export { canonicalLink };

/**
 * RSS / Atom / RDF feeds for the user's sources.
 *
 * `parseFeed` is plain string parsing on purpose: it runs in the MV3 service
 * worker, which has no DOMParser. `createFeedBridge` fetches from the browser
 * (the extension's host permission lets it read feeds cross-origin) with no
 * cookies, so a publisher sees an anonymous reader.
 */

const FEED_TIMEOUT_MS = 15_000;
const SUMMARY_MAX = 300;
const ACCEPT =
  "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, text/html;q=0.5, */*;q=0.4";
const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ensp: " ", emsp: " ", thinsp: " ",
  ndash: "–", mdash: "—", hellip: "…", lsquo: "‘", rsquo: "’", sbquo: "‚", ldquo: "“", rdquo: "”",
  bdquo: "„", laquo: "«", raquo: "»", copy: "©", reg: "®", trade: "™", middot: "·", bull: "•",
  deg: "°", times: "×", divide: "÷", euro: "€", pound: "£", cent: "¢", yen: "¥", sect: "§",
  para: "¶", frac12: "½", frac14: "¼", frac34: "¾", prime: "′", Prime: "″", larr: "←", rarr: "→",
  agrave: "à", aacute: "á", acirc: "â", atilde: "ã", auml: "ä", aring: "å", aelig: "æ", ccedil: "ç",
  egrave: "è", eacute: "é", ecirc: "ê", euml: "ë", igrave: "ì", iacute: "í", icirc: "î", iuml: "ï",
  ntilde: "ñ", ograve: "ò", oacute: "ó", ocirc: "ô", otilde: "õ", ouml: "ö", oslash: "ø",
  ugrave: "ù", uacute: "ú", ucirc: "û", uuml: "ü", yacute: "ý", szlig: "ß",
  Agrave: "À", Aacute: "Á", Acirc: "Â", Auml: "Ä", Aring: "Å", Ccedil: "Ç", Egrave: "È",
  Eacute: "É", Ecirc: "Ê", Iacute: "Í", Ntilde: "Ñ", Oacute: "Ó", Ouml: "Ö", Oslash: "Ø",
  Uacute: "Ú", Uuml: "Ü",
};

function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z][A-Za-z0-9]{1,9}));/g, (whole, dec, hex, name) => {
    if (name) return NAMED_ENTITIES[name] ?? whole;
    const code = dec !== undefined ? Number(dec) : parseInt(hex, 16);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return whole;
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) return "";
    return String.fromCodePoint(code);
  });
}

const BLOCK_TAGS = /<\/?(?:p|br|div|li|ul|ol|h[1-6]|tr|td|blockquote|figure|figcaption|section|article|hr)\b[^>]*>/gi;

function stripTags(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, "")
    .replace(BLOCK_TAGS, " ")
    .replace(/<\/?[A-Za-z][^>]*>/g, "");
}

const collapse = (s: string): string => s.replace(/\s+/g, " ").trim();

const escapeXml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function cap(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.\-–—]+$/, "")}…`;
}

// ---------------------------------------------------------------------------
// Minimal XML scanning
// ---------------------------------------------------------------------------

interface El {
  attrs: string;
  inner: string;
}

/** Every `<name ...>inner</name>` (or self-closing `<name .../>`) in `xml`, outermost first. */
function scan(xml: string, name: string, firstOnly = false): El[] {
  const out: El[] = [];
  const open = new RegExp(`<${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=[\\s>/])`, "g");
  const close = `</${name}>`;
  let m: RegExpExecArray | null;
  while ((m = open.exec(xml))) {
    const gt = xml.indexOf(">", m.index);
    if (gt < 0) break;
    if (xml.charCodeAt(gt - 1) === 47 /* "/" */) {
      out.push({ attrs: xml.slice(m.index + name.length + 1, gt - 1), inner: "" });
      open.lastIndex = gt;
    } else {
      const end = xml.indexOf(close, gt);
      if (end < 0) break;
      out.push({ attrs: xml.slice(m.index + name.length + 1, gt), inner: xml.slice(gt + 1, end) });
      open.lastIndex = end + close.length;
    }
    if (firstOnly) break;
  }
  return out;
}

const first = (xml: string, name: string): El | undefined => scan(xml, name, true)[0];

function attr(attrs: string, name: string): string | undefined {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(attrs);
  const value = m ? (m[1] ?? m[2]) : undefined;
  return value === undefined ? undefined : decodeEntities(value);
}

// ---------------------------------------------------------------------------
// Links, hashing, dates
// ---------------------------------------------------------------------------

const TRACKING_PREFIX = /^(utm_|syn-|mc_|pk_|hsa_|wt\.|oly_|_hs)/;
const TRACKING_PARAMS = new Set([
  "cmp", "cmpid", "intcmp", "cid", "smid", "smtyp", "fbclid", "gclid", "dclid", "msclkid", "igshid",
  "mkt_tok", "ncid", "ocid", "emc", "partner", "referringsource", "ftcamp", "segmentid", "share",
  "ito", "taid", "mbid", "rss", "ex_cid", "campaign",
]);

/** `link` as a clean http(s) URL with tracking parameters and the fragment dropped, or undefined. */
function cleanLink(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  for (const key of [...url.searchParams.keys()]) {
    const k = key.toLowerCase();
    if (TRACKING_PARAMS.has(k) || TRACKING_PREFIX.test(k)) url.searchParams.delete(key);
  }
  url.hash = "";
  return url.toString();
}

/** 12 hex characters of two interleaved FNV-1a-style hashes; stable, not cryptographic. */
function hash12(s: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x9747b28c;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x5bd1e995);
    h2 ^= h2 >>> 15;
  }
  return ((h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0")).slice(0, 12);
}

const ZONES: Record<string, string> = {
  CET: "+0100", CEST: "+0200", BST: "+0100", EET: "+0200", EEST: "+0300", MSK: "+0300",
  JST: "+0900", KST: "+0900", AEST: "+1000", AEDT: "+1100", NZST: "+1200", NZDT: "+1300",
};

/** RFC 822 / RFC 3339 / loose date text to ISO 8601 UTC, or undefined. */
function toIso(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const text = collapse(raw);
  if (!text) return undefined;
  let t = Date.parse(text);
  if (Number.isNaN(t)) {
    const zoned = text.replace(/\b([A-Z]{3,4})$/, (z) => ZONES[z] ?? z);
    t = Date.parse(zoned);
  }
  if (Number.isNaN(t)) return undefined;
  const year = new Date(t).getUTCFullYear();
  if (year < 1990 || year > 2100) return undefined;
  return new Date(t).toISOString();
}

// ---------------------------------------------------------------------------
// parseFeed
// ---------------------------------------------------------------------------

const CDATA = /<!\[CDATA\[([\s\S]*?)\]\]>/g;

/** True when `text` is plausibly an RSS, Atom or RDF document (as opposed to an HTML error page). */
export function looksLikeFeed(text: string): boolean {
  return /<(?:rss|feed|rdf:RDF)[\s>]/i.test(text.slice(0, 4096)) || /<channel[\s>]/i.test(text.slice(0, 20_000));
}

/**
 * Items of an RSS 2.0, Atom or RDF (RSS 1.0) document, mapped to `FeedItem`s.
 * Items without a title or an http(s) link are dropped. Never throws: text that
 * is not a feed yields `[]`.
 */
export function parseFeed(xml: string, source: string): FeedItem[] {
  if (typeof xml !== "string" || !xml) return [];

  // CDATA sections are lifted out so markup inside them can't be mistaken for
  // feed structure, then put back (escaped) wherever an element's text is read.
  const cdata: string[] = [];
  const doc = xml.replace(CDATA, (_, body: string) => `\u0000${cdata.push(body) - 1}\u0000`);
  const unwrap = (s: string): string =>
    s.replace(/\u0000(\d+)\u0000/g, (_, i: string) => escapeXml(cdata[Number(i)] ?? ""));
  /** Element text: entities decoded, tags stripped, whitespace collapsed. Handles escaped HTML and double escaping. */
  const textOf = (inner: string | undefined): string =>
    inner === undefined ? "" : collapse(decodeEntities(stripTags(decodeEntities(unwrap(inner)))));

  const blocks = [...scan(doc, "item"), ...scan(doc, "entry")];
  const items: FeedItem[] = [];
  const seen = new Set<string>();

  for (const { inner: block } of blocks) {
    const title = textOf(first(block, "title")?.inner);
    if (!title) continue;

    const link = cleanLink(linkOf(block, textOf));
    if (!link) continue;

    const key = canonicalLink(link);
    if (seen.has(key)) continue;
    seen.add(key);

    const date = [
      first(block, "pubDate"),
      first(block, "dc:date"),
      first(block, "published"),
      first(block, "dcterms:issued"),
      first(block, "updated"),
      first(block, "dcterms:modified"),
    ]
      .map((e) => (e ? toIso(textOf(e.inner)) : undefined))
      .find(Boolean);

    const summaryRaw = [first(block, "description"), first(block, "summary"), first(block, "content:encoded"), first(block, "content")]
      .map((e) => (e ? textOf(e.inner) : ""))
      .find(Boolean);
    const summary = summaryRaw && summaryRaw.toLowerCase() !== title.toLowerCase() ? cap(summaryRaw, SUMMARY_MAX) : undefined;

    const item: FeedItem = { id: hash12(key), title, link, source };
    if (date) item.publishedAt = date;
    if (summary) item.summary = summary;
    const author = authorOf(block, textOf);
    if (author) item.author = author;
    const section = sectionOf(block, textOf);
    if (section) item.section = section;
    items.push(item);
  }
  return items;
}

function linkOf(block: string, textOf: (s: string) => string): string | undefined {
  const orig = first(block, "feedburner:origLink");
  if (orig) {
    const t = textOf(orig.inner);
    if (t) return t;
  }
  let fallback: string | undefined;
  for (const l of scan(block, "link")) {
    const href = attr(l.attrs, "href");
    if (href) {
      if (!/^https?:\/\//i.test(href)) continue;
      const rel = (attr(l.attrs, "rel") ?? "alternate").toLowerCase();
      const type = (attr(l.attrs, "type") ?? "").toLowerCase();
      if (rel === "alternate" && (type === "" || type.includes("html"))) return href;
      if (rel === "alternate") fallback ??= href;
    } else {
      const t = textOf(l.inner);
      if (t) return t;
    }
  }
  if (fallback) return fallback;
  const guid = first(block, "guid");
  if (guid && attr(guid.attrs, "isPermaLink") !== "false") {
    const t = textOf(guid.inner);
    if (/^https?:\/\//i.test(t)) return t;
  }
  return undefined;
}

function authorOf(block: string, textOf: (s: string) => string): string | undefined {
  const names = scan(block, "dc:creator").map((e) => textOf(e.inner)).filter(Boolean);
  let author = names.join(", ");
  if (!author) {
    const a = first(block, "author");
    if (a) {
      const name = first(a.inner, "name");
      author = textOf(name ? name.inner : a.inner);
      // RSS <author> is "email (Name)" or just an email.
      const paren = /\(([^)]+)\)/.exec(author);
      if (paren) author = paren[1].trim();
      else if (/^\S+@\S+$/.test(author)) author = "";
    }
  }
  author = author.replace(/^by\s+/i, "").trim();
  return author ? cap(author, 120) : undefined;
}

function sectionOf(block: string, textOf: (s: string) => string): string | undefined {
  for (const c of scan(block, "category")) {
    // Some feeds use <category> for non-topic metadata (WSJ: domain="AccessClassName", "PAID").
    if (/AccessClass/i.test(attr(c.attrs, "domain") ?? "")) continue;
    const text = textOf(c.inner) || attr(c.attrs, "label") || attr(c.attrs, "term") || "";
    if (text) return cap(collapse(text), 80);
  }
  const type = first(block, "wsj:articletype");
  const text = type ? textOf(type.inner) : "";
  return text ? cap(text, 80) : undefined;
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

function describeError(err: unknown): string {
  const name = err instanceof Error ? err.name : "";
  if (name === "TimeoutError" || name === "AbortError") return `timed out after ${FEED_TIMEOUT_MS / 1000}s`;
  const message = err instanceof Error ? err.message : String(err);
  if (/^HTTP \d+/.test(message) || /^not an? /.test(message)) return message;
  return `couldn't be reached (${message})`;
}

/** The body of `url` as text, honouring a charset in the header or XML declaration. */
async function fetchText(url: string, signal?: AbortSignal): Promise<string> {
  if (!/^https?:\/\//i.test(url)) throw new Error("not an http(s) address");
  const timeout = AbortSignal.timeout(FEED_TIMEOUT_MS);
  const response = await fetch(url, {
    credentials: "omit",
    redirect: "follow",
    headers: { Accept: ACCEPT },
    signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const bytes = await response.arrayBuffer();
  let charset =
    /charset=["']?([\w-]+)/i.exec(response.headers.get("content-type") ?? "")?.[1] ??
    /<\?xml[^>]*encoding=["']([\w-]+)["']/i.exec(new TextDecoder("latin1").decode(bytes.slice(0, 200)))?.[1] ??
    "utf-8";
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    charset = "utf-8";
    return new TextDecoder(charset).decode(bytes);
  }
}

/** One feed, fetched and parsed. Throws with a human-readable message. */
async function fetchFeed(url: string, source: string): Promise<FeedItem[]> {
  const text = await fetchText(url);
  const items = parseFeed(text, source);
  if (items.length === 0 && !looksLikeFeed(text)) throw new Error("not a feed (no RSS or Atom found)");
  return items;
}

/**
 * Checks an address a person typed: a feed URL, or a page that links to one.
 * Resolves to the feed that answered, or throws a message fit to show.
 */
export async function probeFeed(
  address: string,
): Promise<{ feedUrl: string; itemCount: number; newest?: string; title?: string }> {
  const url = address.trim();
  let text: string;
  try {
    text = await fetchText(url);
  } catch (err) {
    throw new Error(`That address ${describeError(err)}.`);
  }
  let feedUrl = url;
  if (!looksLikeFeed(text)) {
    const linked = findFeedLink(text, url);
    if (!linked) throw new Error("That address isn't an RSS or Atom feed, and the page doesn't link to one.");
    feedUrl = linked;
    try {
      text = await fetchText(feedUrl);
    } catch (err) {
      throw new Error(`The feed that page links to ${describeError(err)}.`);
    }
    if (!looksLikeFeed(text)) throw new Error("The page links to something that isn't a feed.");
  }
  const items = parseFeed(text, "");
  const channel = text.replace(CDATA, (_, b: string) => escapeXml(b));
  const firstItem = channel.search(/<(item|entry)[\s>]/i);
  const head = channel.slice(0, firstItem > 0 ? firstItem : 20_000);
  const title = collapse(decodeEntities(stripTags(first(head, "title")?.inner ?? ""))) || undefined;
  const newest = items.map((i) => i.publishedAt).filter((d): d is string => !!d).sort().pop();
  return { feedUrl, itemCount: items.length, newest, title };
}

/** The first `<link rel="alternate" type="application/(rss|atom)+xml">` in an HTML page, as an absolute URL. */
function findFeedLink(html: string, base: string): string | undefined {
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/rel\s*=\s*["']?alternate/i.test(tag)) continue;
    if (!/type\s*=\s*["']?application\/(?:rss|atom)\+xml/i.test(tag)) continue;
    const href = attr(tag, "href");
    if (!href) continue;
    try {
      return new URL(href, base).toString();
    } catch {
      /* try the next one */
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Bridge
// ---------------------------------------------------------------------------

/**
 * The user's sources' newest articles. Every enabled source's feeds are fetched
 * in parallel; one source failing never affects another (it shows up as that
 * source's `error`). Items are de-duplicated by link, filtered to `sinceHours`
 * by publication time (undated items are kept, after the dated ones), capped at
 * `perSource` per source, and returned newest first.
 */
export function createFeedBridge(sources: FeedSource[]): FeedBridge {
  return {
    async fetchLatest({ sinceHours, perSource }) {
      const now = Date.now();
      const cutoff = now - sinceHours * 60 * 60 * 1000;
      const enabled = sources.filter((s) => s.enabled);

      const perSourceResults = await Promise.all(
        enabled.map(async (source) => {
          const feedUrls = [...new Set(source.feedUrls)];
          if (feedUrls.length === 0) {
            return { source, items: [] as FeedItem[], error: "No feed address set" };
          }
          const settled = await Promise.allSettled(feedUrls.map((url) => fetchFeed(url, source.name)));
          const items: FeedItem[] = [];
          const failures: string[] = [];
          settled.forEach((r, i) => {
            if (r.status === "fulfilled") items.push(...r.value);
            else failures.push(`${feedUrls.length > 1 ? `${new URL(feedUrls[i]).pathname}: ` : ""}${describeError(r.reason)}`);
          });
          let error: string | undefined;
          if (failures.length === feedUrls.length) error = failures[0] + (failures.length > 1 ? ` (+${failures.length - 1} more)` : "");
          else if (failures.length > 0) error = `${failures.length} of ${feedUrls.length} feeds failed: ${failures[0]}`;
          return { source, items, error };
        }),
      );

      const emitted = new Set<string>();
      const statuses: FeedSourceStatus[] = [];
      const all: FeedItem[] = [];

      for (const { source, items, error } of perSourceResults) {
        const byLink = new Map<string, FeedItem>();
        for (const item of items) {
          const key = canonicalLink(item.link);
          if (!byLink.has(key)) byLink.set(key, item);
        }
        const dated: FeedItem[] = [];
        const undated: FeedItem[] = [];
        for (const item of byLink.values()) {
          const t = item.publishedAt ? Date.parse(item.publishedAt) : NaN;
          // A date in the future is a feed bug; treat it as unknown rather than pinning it to the top.
          if (Number.isNaN(t) || t > now + DAY_MS) undated.push(item);
          else if (t >= cutoff) dated.push(item);
        }
        dated.sort((a, b) => Date.parse(b.publishedAt!) - Date.parse(a.publishedAt!));
        const picked = [...dated, ...undated].slice(0, perSource).filter((item) => {
          const key = canonicalLink(item.link);
          if (emitted.has(key)) return false;
          emitted.add(key);
          return true;
        });
        all.push(...picked);
        const status: FeedSourceStatus = { name: source.name, count: picked.length };
        if (error) status.error = error;
        statuses.push(status);
      }

      const time = (item: FeedItem): number => {
        const t = item.publishedAt ? Date.parse(item.publishedAt) : NaN;
        return Number.isNaN(t) || t > now + DAY_MS ? -Infinity : t;
      };
      // Array.prototype.sort is stable, so undated items keep their feed order at the end.
      all.sort((a, b) => time(b) - time(a));
      return { items: all, sources: statuses };
    },
  };
}
