import type { FeedBridge, FeedItem, FeedSource, FeedSourceStatus } from "./types";
import { anySignal } from "./abort";
import { canonicalLink, isTrackingParam, linkId } from "./link";
import { hostOf, isPrivateHost, isSameOrSubdomain } from "./site-filter";

/**
 * RSS / Atom / RDF feeds for the user's sources, and Google News sitemaps (the
 * only public listing some publishers, Reuters among them, offer).
 *
 * Plain string work plus `fetch` and `AbortSignal`: no DOMParser, no `chrome.*`,
 * no `node:*`, so it runs in the MV3 service worker, the new-tab page and Bun.
 * Feeds are fetched with no cookies, so a publisher sees an anonymous reader.
 *
 * Feeds come from the open web and are treated as hostile: bodies are capped
 * (5 MB) and every element's text is cut to 20,000 characters before any text
 * work. An item is searched whole, so its link and date are found wherever the
 * publisher put them (Blogger puts them after a long escaped body); the cap that
 * matters is on the text, not on where an element may sit. Nothing here is
 * quadratic in the size of the input.
 */

/** One feed may take this long; a slow one never holds up another. */
export const FEED_TIMEOUT_MS = 15_000;
/** Bigger bodies are refused (read as a stream and cancelled, not buffered). */
export const MAX_FEED_BYTES = 5 * 1024 * 1024;
const MAX_ITEMS_PER_FEED = 500;
/** A sitemap lists every page of a site; only entries with `<news:news>` count towards the item cap, up to this many scanned. */
const MAX_SITEMAP_URLS = 5_000;
/** The text of one element is cut to this before it is looked at. */
const MAX_ELEMENT_CHARS = 20_000;
const MAX_ATTRS_CHARS = 2_000;
const TITLE_MAX = 300;
const SUMMARY_MAX = 300;
const AUTHOR_MAX = 120;
/** A date this far ahead of now is a feed bug, not news from the future. */
export const FUTURE_SLOP_MS = 5 * 60_000;
const ACCEPT =
  "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, text/html;q=0.5, */*;q=0.4";

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

const BLOCK_TAG_NAMES = new Set([
  "p", "br", "div", "li", "ul", "ol", "h1", "h2", "h3", "h4", "h5", "h6", "tr", "td",
  "blockquote", "figure", "figcaption", "section", "article", "hr",
]);

const isLetter = (c: number): boolean => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);

/**
 * Markup removed in one pass. Block-level tags become a space; comments, scripts
 * and styles go with their content; a `<` that doesn't start a tag is text. An
 * unterminated construct ends the pass (everything after it can't be terminated
 * either), which keeps this linear.
 */
function stripTags(html: string): string {
  let out = "";
  let lower: string | undefined;
  let i = 0;
  const n = html.length;
  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      out += html.slice(i);
      break;
    }
    out += html.slice(i, lt);
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      if (end < 0) break;
      i = end + 3;
      continue;
    }
    const head = /^<(\/?)([A-Za-z][A-Za-z0-9]*)/.exec(html.slice(lt, lt + 24));
    if (!head) {
      out += "<";
      i = lt + 1;
      continue;
    }
    const name = head[2].toLowerCase();
    if (!head[1] && (name === "script" || name === "style")) {
      lower ??= html.toLowerCase();
      const end = lower.indexOf(`</${name}`, lt);
      if (end < 0) break;
      const gt = html.indexOf(">", end);
      if (gt < 0) break;
      i = gt + 1;
      continue;
    }
    const gt = html.indexOf(">", lt);
    if (gt < 0) {
      out += html.slice(lt);
      break;
    }
    if (BLOCK_TAG_NAMES.has(name)) out += " ";
    i = gt + 1;
  }
  return out;
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

/**
 * Every `<name ...>inner</name>` (or self-closing `<name .../>`) in `xml`, outermost
 * first. An element with no closing tag ends the scan: nothing after it is read.
 */
function scan(xml: string, name: string, opts: { firstOnly?: boolean; maxInner?: number; limit?: number } = {}): El[] {
  const out: El[] = [];
  const open = new RegExp(`<${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=[\\s>/])`, "g");
  const close = `</${name}>`;
  const maxInner = opts.maxInner ?? MAX_ELEMENT_CHARS;
  let m: RegExpExecArray | null;
  while ((m = open.exec(xml))) {
    const gt = xml.indexOf(">", m.index);
    if (gt < 0) break;
    const attrs = xml.slice(m.index + name.length + 1, Math.min(gt, m.index + name.length + 1 + MAX_ATTRS_CHARS));
    if (xml.charCodeAt(gt - 1) === 47 /* "/" */) {
      out.push({ attrs, inner: "" });
      open.lastIndex = gt;
    } else {
      const end = xml.indexOf(close, gt);
      if (end < 0) break;
      out.push({ attrs, inner: xml.slice(gt + 1, Math.min(end, gt + 1 + maxInner)) });
      open.lastIndex = end + close.length;
    }
    if (opts.firstOnly || (opts.limit !== undefined && out.length >= opts.limit)) break;
  }
  return out;
}

const first = (xml: string, name: string, maxInner?: number): El | undefined =>
  scan(xml, name, { firstOnly: true, maxInner })[0];

function attr(attrs: string, name: string): string | undefined {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(attrs.slice(0, MAX_ATTRS_CHARS));
  const value = m ? (m[1] ?? m[2]) : undefined;
  return value === undefined ? undefined : decodeEntities(value);
}

// ---------------------------------------------------------------------------
// Links and dates
// ---------------------------------------------------------------------------

/** `link` as a clean http(s) URL with tracking parameters and the fragment dropped, or undefined. */
function cleanLink(raw: string | undefined): string | undefined {
  if (!raw || raw.length > 4000) return undefined;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  for (const [key, value] of [...url.searchParams.entries()]) {
    if (isTrackingParam(key, value)) url.searchParams.delete(key);
  }
  url.hash = "";
  return url.toString();
}

const ZONES: Record<string, string> = {
  CET: "+0100", CEST: "+0200", BST: "+0100", EET: "+0200", EEST: "+0300", MSK: "+0300",
  JST: "+0900", KST: "+0900", AEST: "+1000", AEDT: "+1100", NZST: "+1200", NZDT: "+1300",
};

/** RFC 822 / RFC 3339 / loose date text to ISO 8601 UTC, or undefined. */
function toIso(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const text = collapse(raw.slice(0, 120));
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

/**
 * When an item counts as published, for ordering and grouping: its date, held to
 * `now` if it is a few minutes ahead (clock skew), and `-Infinity` (unknown) when
 * it has none or is further ahead than that.
 */
export function effectiveTime(publishedAt: string | undefined, now: number): number {
  const t = publishedAt ? Date.parse(publishedAt) : NaN;
  if (Number.isNaN(t) || t > now + FUTURE_SLOP_MS) return -Infinity;
  return Math.min(t, now);
}

// ---------------------------------------------------------------------------
// parseFeed
// ---------------------------------------------------------------------------

/**
 * True when `text` is plausibly an RSS, Atom or RDF document, or a news sitemap
 * (a `<urlset>` with `<news:news>` entries), as opposed to an HTML error page.
 */
export function looksLikeFeed(text: string): boolean {
  const head = text.slice(0, 4096);
  return (
    /<(?:rss|feed|rdf:RDF)[\s>]/i.test(head) ||
    /<channel[\s>]/i.test(text.slice(0, 20_000)) ||
    (/<urlset[\s>]/i.test(head) && /<news:news[\s>]/i.test(text.slice(0, 20_000)))
  );
}

/** CDATA bodies lifted out of `xml` (so markup inside can't pass for structure), in one linear pass. */
function liftCdata(xml: string): { doc: string; bodies: string[] } {
  const bodies: string[] = [];
  const clean = xml.includes("\u0000") ? xml.replace(/\u0000/g, "") : xml;
  let doc = "";
  let pos = 0;
  for (;;) {
    const start = clean.indexOf("<![CDATA[", pos);
    if (start < 0) break;
    const end = clean.indexOf("]]>", start + 9);
    if (end < 0) break;
    doc += clean.slice(pos, start) + `\u0000${bodies.push(clean.slice(start + 9, end)) - 1}\u0000`;
    pos = end + 3;
  }
  return { doc: doc + clean.slice(pos), bodies };
}

interface RawItem {
  title: string;
  link: string;
  key: string;
  publishedAt?: string;
  /** Set for sitemap entries, which have no `<category>` to read it from. */
  section?: string;
  block: string;
  /** Text of an element: for summaries, escaped HTML is decoded and its markup removed. */
  html: (inner: string | undefined) => string;
  plain: (inner: string | undefined) => string;
}

/** The items of a document with only what dating and ordering need; the rest is read by `finish`. */
function parseRaw(xml: string): RawItem[] {
  if (typeof xml !== "string" || !xml) return [];
  const { doc, bodies } = liftCdata(xml);
  const unwrapRaw = (s: string): string => s.replace(/\u0000(\d+)\u0000/g, (_, i: string) => bodies[Number(i)] ?? "");
  const unwrapEscaped = (s: string): string =>
    s.replace(/\u0000(\d+)\u0000/g, (_, i: string) => escapeXml(bodies[Number(i)] ?? ""));
  /**
   * Headlines, authors, sections: text. Real markup is removed, but escaped markup
   * (`&lt;b&gt;`) is what the publisher wrote and stays as typed.
   */
  const plain = (inner: string | undefined): string =>
    inner === undefined ? "" : collapse(decodeEntities(decodeEntities(stripTags(unwrapRaw(inner.slice(0, MAX_ELEMENT_CHARS))))));
  /** Summaries: HTML is expected, plain or escaped, so decode, strip, decode. */
  const html = (inner: string | undefined): string =>
    inner === undefined
      ? ""
      : collapse(decodeEntities(stripTags(decodeEntities(unwrapEscaped(inner.slice(0, MAX_ELEMENT_CHARS))))));

  const blocks = [
    ...scan(doc, "item", { maxInner: Infinity, limit: MAX_ITEMS_PER_FEED }),
    ...scan(doc, "entry", { maxInner: Infinity, limit: MAX_ITEMS_PER_FEED }),
  ].slice(0, MAX_ITEMS_PER_FEED);
  const out: RawItem[] = [];
  const seen = new Set<string>();

  if (blocks.length === 0 && /<urlset[\s>]/i.test(doc.slice(0, 4096))) {
    let news = 0;
    for (const { inner: block } of scan(doc, "url", { maxInner: Infinity, limit: MAX_SITEMAP_URLS })) {
      const entry = first(block, "news:news");
      if (!entry) continue;
      if (++news > MAX_ITEMS_PER_FEED) break;
      const title = cap(plain(first(entry.inner, "news:title")?.inner), TITLE_MAX);
      if (!title) continue;
      const loc = first(block, "loc");
      const link = cleanLink(loc ? plain(loc.inner) : undefined);
      if (!link) continue;
      const language = plain(first(entry.inner, "news:language")?.inner).toLowerCase().split(/[-_]/)[0];
      const info = sitemapEntry(link, plain(first(entry.inner, "news:keywords")?.inner), language);
      if (!info) continue;
      const key = canonicalLink(link);
      if (seen.has(key)) continue;
      seen.add(key);
      const date = first(entry.inner, "news:publication_date") ?? first(block, "lastmod");
      out.push({
        title,
        link,
        key,
        publishedAt: date ? toIso(plain(date.inner)) : undefined,
        section: info.section || undefined,
        block: "",
        html,
        plain,
      });
    }
    return out;
  }

  for (const { inner: block } of blocks) {
    const title = cap(plain(first(block, "title")?.inner), TITLE_MAX);
    if (!title) continue;
    const link = cleanLink(linkOf(block, plain));
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
      .map((e) => (e ? toIso(plain(e.inner)) : undefined))
      .find(Boolean);

    out.push({ title, link, key, publishedAt: date, block, html, plain });
  }
  return out;
}

/** The rest of an item: summary, author, section. Only done for items that will be shown. */
function finish(raw: RawItem, source: string): FeedItem {
  const item: FeedItem = { id: linkId(raw.link), title: raw.title, link: raw.link, source };
  if (raw.publishedAt) item.publishedAt = raw.publishedAt;
  const summaryRaw = [
    first(raw.block, "description"),
    first(raw.block, "summary"),
    first(raw.block, "content:encoded"),
    first(raw.block, "content"),
  ]
    .map((e) => (e ? raw.html(e.inner) : ""))
    .find(Boolean);
  if (summaryRaw && summaryRaw.toLowerCase() !== raw.title.toLowerCase()) item.summary = cap(summaryRaw, SUMMARY_MAX);
  const author = authorOf(raw.block, raw.plain);
  if (author) item.author = author;
  const section = raw.section ?? sectionOf(raw.block, raw.plain);
  if (section) item.section = section;
  return item;
}

/**
 * Items of an RSS 2.0, Atom or RDF (RSS 1.0) document, mapped to `FeedItem`s.
 * Items without a title or an http(s) link are dropped. Never throws: text that
 * is not a feed yields `[]`.
 */
export function parseFeed(xml: string, source: string): FeedItem[] {
  return parseRaw(xml).map((raw) => finish(raw, source));
}

/**
 * Language editions that publishers keep under one host, by the path segment that
 * marks them ("/fr/", "/latam/", "/fact-check/portugues/") and the language they are in.
 */
const EDITION_LANGUAGE = new Map<string, string>(
  Object.entries({
    fr: "fr", pt: "pt", latam: "es", es: "es", de: "de", it: "it", nl: "nl", pl: "pl", sv: "sv", tr: "tr",
    ru: "ru", ar: "ar", he: "he", hi: "hi", id: "id", ja: "ja", jp: "ja", ko: "ko", zh: "zh", cn: "zh",
    portugues: "pt", espanol: "es", francais: "fr", deutsch: "de", italiano: "it",
  }),
);
/** The spelled-out names are also used as a second path segment ("/fact-check/portugues/…"). */
const EDITION_NAMES = new Set(["portugues", "espanol", "francais", "deutsch", "italiano"]);
const LANGUAGE_SEGMENT = /^[a-z]{2}(?:-[a-z]{2,4})?$/;

/**
 * What a sitemap entry contributes, or null when it is left out.
 *
 * Left out: an entry in a language edition (see `EDITION_LANGUAGE`) of a Reuters
 * sitemap, whose `news:language` says "en" for every edition, or one whose declared
 * `news:language` is not the edition's language. A sitemap that declares the edition's
 * own language ("/de/" with `news:language` "de") is read in full.
 *
 * Section: the first non-empty keyword, else the first path segment that is not a
 * language or region code and has an article segment after it ("/world/india/…" and
 * "/en/world/…" are "World"; a code is never a section); "" when neither says.
 */
function sitemapEntry(link: string, keywords: string, declaredLanguage: string): { section: string } | null {
  let host = "";
  let segments: string[] = [];
  try {
    const url = new URL(link);
    host = url.hostname.toLowerCase();
    segments = url.pathname.toLowerCase().split("/").filter(Boolean);
  } catch {
    /* no path */
  }
  const edition =
    EDITION_LANGUAGE.get(segments[0] ?? "") ??
    (EDITION_NAMES.has(segments[1] ?? "") ? EDITION_LANGUAGE.get(segments[1]!) : undefined);
  if (edition) {
    const reuters = isSameOrSubdomain(host.replace(/^www\./, ""), "reuters.com");
    if (reuters || (declaredLanguage !== "" && declaredLanguage !== edition)) return null;
  }
  const keyword = keywords
    .split(",")
    .map((k) => k.trim())
    .find(Boolean);
  if (keyword) return { section: cap(keyword, 80) };
  while (segments.length > 1 && (EDITION_LANGUAGE.has(segments[0]) || LANGUAGE_SEGMENT.test(segments[0]))) {
    segments = segments.slice(1);
  }
  const segment = segments[0] ?? "";
  if (segments.length < 2 || !/^[a-z][a-z-]{1,40}$/.test(segment)) return { section: "" };
  return {
    section: segment
      .split("-")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" "),
  };
}

function linkOf(block: string, textOf: (s: string) => string): string | undefined {
  const orig = first(block, "feedburner:origLink");
  if (orig) {
    const t = textOf(orig.inner);
    if (t) return t;
  }
  let fallback: string | undefined;
  for (const l of scan(block, "link", { limit: 20 })) {
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
  const names = scan(block, "dc:creator", { limit: 10 }).map((e) => textOf(e.inner)).filter(Boolean);
  let author = names.join(", ").slice(0, 500);
  if (!author) {
    const a = first(block, "author");
    if (a) {
      const name = first(a.inner, "name");
      author = textOf(name ? name.inner : a.inner).slice(0, 500);
      // RSS <author> is "email (Name)" or just an email.
      const paren = /\(([^)]{1,200})\)/.exec(author);
      if (paren) author = paren[1].trim();
      else if (/^\S+@\S+$/.test(author)) author = "";
    }
  }
  author = author.replace(/^by\s+/i, "").trim();
  return author ? cap(author, AUTHOR_MAX) : undefined;
}

function sectionOf(block: string, textOf: (s: string) => string): string | undefined {
  for (const c of scan(block, "category", { limit: 10 })) {
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

/** A reason that finishes "…", "That address …" and "The feed that page links to …". */
export function describeFeedError(err: unknown): string {
  const name = err instanceof Error ? err.name : "";
  if (name === "TimeoutError" || name === "AbortError") return `timed out after ${FEED_TIMEOUT_MS / 1000} s`;
  const message = err instanceof Error ? err.message : String(err);
  const http = /^HTTP (\d+)/.exec(message);
  if (http) {
    // Some publishers (Reuters, behind a bot check) turn away requests from some networks and clients.
    if (http[1] === "401" || http[1] === "403") return `turned this request away (HTTP ${http[1]})`;
    return `answered with HTTP ${http[1]}`;
  }
  if (message === "not a feed") return "isn't an RSS or Atom feed";
  if (message === "too large") return `is bigger than ${MAX_FEED_BYTES / 1024 / 1024} MB`;
  if (message === "private redirect") return "redirected to a private or local address";
  if (message === "not http") return "isn't a web address";
  return `couldn't be reached (${message})`;
}

class FeedFetchError extends Error {}

/** The response body as text, refusing (and cancelling) anything over the cap. */
async function readCapped(response: Response): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_FEED_BYTES) {
    void response.body?.cancel().catch(() => {});
    throw new FeedFetchError("too large");
  }
  const reader = response.body?.getReader();
  if (!reader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > MAX_FEED_BYTES) throw new FeedFetchError("too large");
    return bytes;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_FEED_BYTES) {
      void reader.cancel().catch(() => {});
      throw new FeedFetchError("too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return bytes;
}

/**
 * The body of `url` as text, honouring a charset in the header or XML declaration.
 * A public address that redirects to a private, loopback or link-local one is
 * refused (the request has already been made by then; its body is discarded).
 */
async function fetchText(url: string, signal?: AbortSignal): Promise<string> {
  if (!/^https?:\/\//i.test(url)) throw new FeedFetchError("not http");
  const timeout = AbortSignal.timeout(FEED_TIMEOUT_MS);
  const response = await fetch(url, {
    credentials: "omit",
    redirect: "follow",
    headers: { Accept: ACCEPT },
    signal: signal ? anySignal([timeout, signal]) : timeout,
  });
  if (response.url && !isPrivateHost(hostOf(url)) && isPrivateHost(hostOf(response.url))) {
    void response.body?.cancel().catch(() => {});
    throw new FeedFetchError("private redirect");
  }
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    throw new FeedFetchError(`HTTP ${response.status}`);
  }
  const bytes = await readCapped(response);
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

/**
 * Checks an address a person typed: a feed URL, or a page that links to one.
 * Resolves to the feed that answered, or throws a message fit to show.
 */
export async function probeFeed(
  address: string,
): Promise<{ feedUrl: string; itemCount: number; newest?: string; title?: string }> {
  const url = address.trim();
  if (isPrivateHost(hostOf(url))) {
    throw new Error(
      "That address is on your own computer or local network. Latest only reads feeds on the public internet.",
    );
  }
  let text: string;
  try {
    text = await fetchText(url);
  } catch (err) {
    throw new Error(`That address ${describeFeedError(err)}.`);
  }
  let feedUrl = url;
  if (!looksLikeFeed(text)) {
    const linked = findFeedLink(text, url);
    if (!linked) throw new Error("That address isn't an RSS or Atom feed, and the page doesn't link to one.");
    feedUrl = linked;
    try {
      text = await fetchText(feedUrl);
    } catch (err) {
      throw new Error(`The feed that page links to ${describeFeedError(err)}.`);
    }
    if (!looksLikeFeed(text)) throw new Error("The page links to something that isn't a feed.");
  }
  const items = parseRaw(text);
  const { doc, bodies } = liftCdata(text.slice(0, 200_000));
  const firstItem = doc.search(/<(item|entry)[\s>]/i);
  const head = doc.slice(0, firstItem > 0 ? firstItem : 20_000);
  const rawTitle = first(head, "title")?.inner ?? first(head, "news:name")?.inner;
  const title =
    rawTitle === undefined
      ? undefined
      : collapse(
          decodeEntities(stripTags(rawTitle.slice(0, 2000).replace(/\u0000(\d+)\u0000/g, (_, i: string) => bodies[Number(i)] ?? ""))),
        ).slice(0, 200) || undefined;
  const newest = items.map((i) => i.publishedAt).filter((d): d is string => !!d).sort().pop();
  return { feedUrl, itemCount: items.length, newest, title };
}

/**
 * The first `<link rel="alternate" type="application/(rss|atom)+xml">` in an HTML
 * page, as an absolute http(s) URL. One that points at a private, loopback or
 * link-local host is ignored.
 */
function findFeedLink(html: string, base: string): string | undefined {
  const head = html.slice(0, 200_000);
  const lower = head.toLowerCase();
  let from = 0;
  for (let n = 0; n < 200; n++) {
    const start = lower.indexOf("<link", from);
    if (start < 0) break;
    const end = head.indexOf(">", start);
    if (end < 0) break;
    from = end + 1;
    const tag = head.slice(start, Math.min(end + 1, start + MAX_ATTRS_CHARS));
    if (!/rel\s*=\s*["']?alternate/i.test(tag)) continue;
    if (!/type\s*=\s*["']?application\/(?:rss|atom)\+xml/i.test(tag)) continue;
    const href = attr(tag, "href");
    if (!href) continue;
    try {
      const absolute = new URL(href, base);
      if (absolute.protocol !== "http:" && absolute.protocol !== "https:") continue;
      if (isPrivateHost(hostOf(absolute.href))) continue;
      return absolute.toString();
    } catch {
      /* try the next one */
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Bridge
// ---------------------------------------------------------------------------

export interface FetchWindow {
  sinceHours: number;
  perSource: number;
  /** Defaults to the current time. */
  now?: number;
}

/** What one source's feeds gave, so far or in the end. */
export interface SourceFetch {
  /** The source's display name, as in `FeedItem.source` and `FeedSourceStatus.name`. */
  name: string;
  items: FeedItem[];
  error?: string;
  /** False while some of the source's feeds are still on their way. */
  done: boolean;
}

/** One feed's items inside the window: dated newest first, then undated, at most `limit`. */
function selectFromFeed(xml: string, source: string, w: Required<FetchWindow>): FeedItem[] {
  const cutoff = w.now - w.sinceHours * 3_600_000;
  const dated: Array<{ raw: RawItem; t: number }> = [];
  const undated: RawItem[] = [];
  for (const raw of parseRaw(xml)) {
    const t = effectiveTime(raw.publishedAt, w.now);
    if (t === -Infinity) undated.push(raw);
    else if (t >= cutoff) dated.push({ raw, t });
  }
  dated.sort((a, b) => b.t - a.t);
  return [...dated.map((d) => d.raw), ...undated].slice(0, w.perSource).map((raw) => finish(raw, source));
}

/**
 * One source's feeds, fetched in parallel. `onProgress` fires as each feed settles
 * with what the source has so far (`done: false` until the last one), so a caller
 * can show a source's stories without waiting for the slowest feed of another.
 * Never throws.
 */
export async function fetchSourceFeeds(
  source: FeedSource,
  window: FetchWindow,
  hooks: { signal?: AbortSignal; onProgress?: (partial: SourceFetch) => void } = {},
): Promise<SourceFetch> {
  const w: Required<FetchWindow> = { ...window, now: window.now ?? Date.now() };
  const feedUrls = [...new Set(source.feedUrls)];
  if (feedUrls.length === 0) {
    const result = { name: source.name, items: [], error: "No feed address set", done: true };
    hooks.onProgress?.(result);
    return result;
  }
  const items: FeedItem[] = [];
  const failures: string[] = [];
  let settled = 0;
  const snapshot = (): SourceFetch => {
    const done = settled === feedUrls.length;
    let error: string | undefined;
    if (done && failures.length === feedUrls.length) {
      error = failures[0] + (failures.length > 1 ? ` (+${failures.length - 1} more)` : "");
    } else if (done && failures.length > 0) {
      error = `${failures.length} of ${feedUrls.length} feeds failed: ${failures[0]}`;
    }
    return { name: source.name, items: [...items], error, done };
  };
  await Promise.all(
    feedUrls.map(async (url) => {
      try {
        const text = await fetchText(url, hooks.signal);
        const picked = selectFromFeed(text, source.name, w);
        if (picked.length === 0 && !looksLikeFeed(text)) throw new FeedFetchError("not a feed");
        items.push(...picked);
      } catch (err) {
        let where = "";
        if (feedUrls.length > 1) {
          try {
            where = `${new URL(url).pathname}: `;
          } catch {
            where = `${url.slice(0, 60)}: `;
          }
        }
        failures.push(`${where}${describeFeedError(err)}`);
      }
      settled++;
      hooks.onProgress?.(snapshot());
    }),
  );
  return snapshot();
}

/**
 * The sources' fetches combined into the stream: de-duplicated by link within a
 * source and across sources (earlier sources win), filtered to the window by
 * publication time (undated items are kept, after the dated ones), capped at
 * `perSource` per source, and returned newest first.
 */
export function mergeSourceFetches(
  results: SourceFetch[],
  window: FetchWindow,
): { items: FeedItem[]; sources: FeedSourceStatus[] } {
  const now = window.now ?? Date.now();
  const cutoff = now - window.sinceHours * 3_600_000;
  const emitted = new Set<string>();
  const statuses: FeedSourceStatus[] = [];
  const all: FeedItem[] = [];

  for (const { name, items, error } of results) {
    const byLink = new Map<string, FeedItem>();
    for (const item of items) {
      const key = canonicalLink(item.link);
      if (!byLink.has(key)) byLink.set(key, item);
    }
    const dated: Array<{ item: FeedItem; t: number }> = [];
    const undated: FeedItem[] = [];
    for (const item of byLink.values()) {
      const t = effectiveTime(item.publishedAt, now);
      if (t === -Infinity) undated.push(item);
      else if (t >= cutoff) dated.push({ item, t });
    }
    dated.sort((a, b) => b.t - a.t);
    const picked = [...dated.map((d) => d.item), ...undated].slice(0, window.perSource).filter((item) => {
      const key = canonicalLink(item.link);
      if (emitted.has(key)) return false;
      emitted.add(key);
      return true;
    });
    all.push(...picked);
    const status: FeedSourceStatus = { name, count: picked.length };
    if (error) status.error = error;
    statuses.push(status);
  }

  // Array.prototype.sort is stable, so undated items keep their feed order at the end.
  all.sort((a, b) => effectiveTime(b.publishedAt, now) - effectiveTime(a.publishedAt, now));
  return { items: all, sources: statuses };
}

/**
 * The user's sources' newest articles. Every enabled source's feeds are fetched
 * in parallel; one source failing never affects another (it shows up as that
 * source's `error`).
 */
export function createFeedBridge(sources: FeedSource[]): FeedBridge {
  return {
    async fetchLatest({ sinceHours, perSource }) {
      const window = { sinceHours, perSource, now: Date.now() };
      const enabled = sources.filter((s) => s.enabled);
      const results = await Promise.all(enabled.map((source) => fetchSourceFeeds(source, window)));
      return mergeSourceFetches(results, window);
    },
  };
}
