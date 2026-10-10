/**
 * Link helpers shared by the tool handlers and the extension's feed parser.
 * Pure string work: no `chrome.*`, `browser.*` or `node:*`.
 */

/** Longest link the model is ever handed. Anything longer is dropped, not truncated. */
export const MAX_LINK_LENGTH = 2000;

const TRACKING_PREFIX = /^(utm_|syn-|mc_|pk_|hsa_|wt\.|oly_|_hs)/;
const TRACKING_PARAMS = new Set([
  "cmp", "cmpid", "intcmp", "cid", "smid", "smtyp", "fbclid", "gclid", "dclid", "msclkid", "igshid",
  "mkt_tok", "ncid", "ocid", "emc", "partner", "referringsource", "ftcamp", "segmentid", "share",
  "ito", "taid", "mbid", "rss", "ex_cid", "campaign",
]);

/** True for the query parameters that only say where a click came from. */
export function isTrackingParam(key: string): boolean {
  const k = key.toLowerCase();
  return TRACKING_PARAMS.has(k) || TRACKING_PREFIX.test(k);
}

/**
 * A key two spellings of the same article share: no scheme, `www.`, fragment,
 * trailing slash or tracking parameters, and the remaining query in sorted order.
 */
export function canonicalLink(link: string): string {
  try {
    const u = new URL(link);
    const params = [...u.searchParams.entries()]
      .filter(([k]) => !isTrackingParam(k))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const query = params.length ? `?${params.map(([k, v]) => `${k}=${v}`).join("&")}` : "";
    const path = u.pathname.replace(/\/+$/, "");
    return `${u.hostname.toLowerCase().replace(/^www\./, "")}${path}${query}`;
  } catch {
    return link;
  }
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

/** The id a feed item carries: a stable hash of its canonical link. */
export function linkId(link: string): string {
  return hash12(canonicalLink(link));
}

/**
 * `raw` as the string the model gets to put in an href or a message: the parsed
 * `href` of an http(s) URL with quotes, backticks and whitespace percent-encoded,
 * so it can't break out of an attribute or a template literal. Undefined when it
 * is not an http(s) URL or is longer than MAX_LINK_LENGTH.
 */
export function safeLink(raw: string): string | undefined {
  if (typeof raw !== "string" || raw.length > MAX_LINK_LENGTH * 2) return undefined;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  const href = url.href.replace(/['"`\s]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
  return href.length > MAX_LINK_LENGTH ? undefined : href;
}

/** `safeLink` with the fragment cleared: the exact-match key for "this link was shown to the model". */
export function linkKey(raw: string): string | undefined {
  const href = safeLink(raw);
  if (href === undefined) return undefined;
  const hash = href.indexOf("#");
  return hash < 0 ? href : href.slice(0, hash);
}
