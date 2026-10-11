import {
  DEFAULT_BLOCKED_SITES,
  hostOf,
  isAllowedUrl,
  normalizeArchiveUrl,
  type ArchiveArticleMeta,
} from "@homepage/agent-core";
import {
  ArticleFetchError,
  MAX_IMPORT_BYTES,
  MAX_URL_LENGTH,
  importPage,
  lookupArticle,
  readArticle,
  type FetchFailure,
  type FetchStage,
  type FullArticleResult,
} from "./archive-save";
import { createScraperWindow, waitForTabLoad } from "./scraper";
import { KEYS, extensionStore } from "./storage";

/**
 * "Capture with my browser": load an article in the person's own, signed-in
 * browser and hand the page's HTML to their local Amber, for the publishers whose
 * subscription Amber's anonymous capture cannot see through.
 *
 * Only ever started by a click in the Reader. The page leaves the browser only
 * for Amber's `POST /api/import` on the configured archive address.
 *
 * Known residual: if the extension is reloaded or the browser quits mid-capture,
 * the background window it opened is not closed (nothing of ours is running to
 * close it). It holds one article page and can simply be closed.
 */

const LOAD_TIMEOUT_MS = 30_000;
/** After load, let a single-page app render before the page is scrolled and read. */
const SETTLE_MS = 2_000;
/**
 * The scroll-and-read script has this long, once the page has loaded. The content script
 * stops scrolling after about 8 s in raw mode, so this is slack for a busy page.
 */
const EXTRACT_TIMEOUT_MS = 20_000;
/** Injection attempts (not read attempts: a script that timed out is never run again). */
const INJECT_ATTEMPTS = 3;
const INJECT_RETRY_MS = 1_000;

/** What `entrypoints/scraper.content.ts` hands back when it was asked for the raw document. */
interface RawDocument {
  url: string;
  title: string;
  html: string;
  tooBig?: boolean;
}

type CaptureFailure = Extract<
  FetchFailure,
  "blocked" | "off-site" | "timeout" | "no-content" | "too-big" | "closed" | "aborted"
>;

export type BrowserCaptureResult =
  | {
      ok: true;
      /** The page's untouched `document.documentElement.outerHTML`, at most 12 MB. */
      html: string;
      title: string;
      /** Where the page ended up after redirects (same site as the one asked for, and allowed). */
      finalUrl: string;
    }
  | { ok: false; reason: CaptureFailure; detail?: string };

class Stop extends Error {
  constructor(
    readonly reason: CaptureFailure,
    readonly detail?: string,
  ) {
    super(reason);
  }
}

/** Reject with `aborted` as soon as `signal` fires, whatever `work` is still doing. */
function abortable<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) return reject(new Stop("aborted"));
    const onAbort = () => reject(new Stop("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

const pause = (ms: number, signal?: AbortSignal) =>
  abortable(new Promise<void>((resolve) => setTimeout(resolve, ms)), signal);

const isWeb = (url: string | undefined) => /^https?:/i.test(url ?? "");

/**
 * Suffixes under which one more label is the registrable domain: common two-label public
 * suffixes, then shared-hosting suffixes (where `a.github.io` and `b.github.io` are different
 * owners). This list and `sameSite` mirror Amber's rule exactly; Amber is the authority (see its
 * README, "Same-site rule for final_url"), so change both together or not at all.
 */
const REGISTRABLE_SUFFIXES = [
  // two-label public suffixes
  "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "ltd.uk", "plc.uk",
  "com.au", "net.au", "org.au", "edu.au", "gov.au",
  "co.nz", "org.nz", "govt.nz",
  "co.jp", "or.jp", "ne.jp", "ac.jp", "go.jp",
  "com.br", "net.br", "org.br",
  "com.cn", "net.cn", "org.cn",
  "com.hk", "com.sg", "com.tw", "com.mx", "com.ar", "com.tr", "com.ua",
  "co.in", "net.in", "org.in",
  "co.za", "co.kr", "or.kr", "co.il", "co.id",
  "com.my", "com.ph", "com.pk", "com.eg", "com.sa", "com.ng",
  // shared hosting
  "github.io", "gitlab.io", "blogspot.com", "herokuapp.com", "vercel.app", "netlify.app", "pages.dev",
  "workers.dev", "web.app", "firebaseapp.com", "azurewebsites.net", "cloudfront.net", "s3.amazonaws.com",
  "appspot.com", "wordpress.com", "substack.com", "medium.com", "wixsite.com", "myshopify.com",
  "tumblr.com", "squarespace.com", "ghost.io", "notion.site",
].sort((a, b) => b.split(".").length - a.split(".").length);

/** The URL's host as the browser parses it (punycoded, lowercase), without a trailing dot; "" if unparsable. */
function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return "";
  }
}

/** The explicit port, with the defaults of both schemes (80 and 443) counting as one "default". */
function portOf(url: string): string {
  try {
    const port = new URL(url).port;
    return port === "" || port === "80" || port === "443" ? "default" : port;
  } catch {
    return "";
  }
}

/** The owner-level part of a host. IP literals and regional S3 endpoints are their own domain. */
function registrableDomain(host: string): string {
  if (!host || host.includes(":") || /^\d+\.\d+\.\d+\.\d+$/.test(host)) return host;
  const labels = host.split(".");
  if (host.endsWith(".amazonaws.com") && labels.some((l) => l === "s3" || l.startsWith("s3-"))) return host;
  for (const suffix of REGISTRABLE_SUFFIXES) {
    if (host === suffix) return host;
    if (host.endsWith(`.${suffix}`)) {
      const count = suffix.split(".").length + 1;
      return labels.slice(-count).join(".");
    }
  }
  return labels.slice(-2).join(".");
}

/**
 * Amber's same-site rule for a page's final address: the same host or the same registrable
 * domain, and the same port (or both on a default port, 80 or 443; the scheme is not compared).
 * IP literals only match exactly. A shortener or an SSO host is a different site, on purpose.
 */
export function sameSite(a: string, b: string): boolean {
  const [hostA, hostB] = [hostnameOf(a), hostnameOf(b)];
  if (!hostA || !hostB) return false;
  if (portOf(a) !== portOf(b)) return false;
  return hostA === hostB || registrableDomain(hostA) === registrableDomain(hostB);
}

/** True once the tab has finished loading a web page. Also true when it finished before we looked. */
async function pageLoaded(tabId: number, signal: AbortSignal): Promise<boolean> {
  const stop = new AbortController();
  const wait = waitForTabLoad(tabId, LOAD_TIMEOUT_MS, AbortSignal.any([signal, stop.signal]));
  try {
    // The listener above is already registered, so a load that ends from here on is not missed;
    // this look covers one that ended before it was.
    const tab = await browser.tabs.get(tabId).catch(() => null);
    if (!tab) return false;
    if (tab.status === "complete" && isWeb(tab.url)) return true;
    return await wait;
  } finally {
    stop.abort();
  }
}

/** `document.readyState` of the tab's page, or null when it cannot be read. */
async function readyStateOf(tabId: number): Promise<string | null> {
  try {
    const [res] = await browser.scripting.executeScript({ target: { tabId }, func: () => document.readyState });
    return typeof res?.result === "string" ? res.result : null;
  } catch {
    return null;
  }
}

/**
 * Open `url` in a background window of the person's own browser (their cookies and
 * subscriptions apply), let it settle, scroll it the way the scraper does to wake
 * lazy content, and return the document's raw HTML for Amber's extractor. Never
 * throws: failures come back typed. The window is closed on every path, also when
 * `signal` aborts or the new-tab page is closed, and the capture ends at once if
 * the person closes that window or tab.
 *
 * Refuses (without opening anything) a link that is not http(s), is on a
 * loopback, private or local-network host, or is on the person's blocked-sites
 * list. The page's address after redirects must pass the same checks and be the
 * same site as the one asked for, before the page is scrolled or read and again
 * before its HTML is returned. Neither URLs nor HTML are logged.
 */
export async function captureWithBrowser(
  url: string,
  opts: {
    signal?: AbortSignal;
    onStatus?: (stage: "opening") => void;
  } = {},
): Promise<BrowserCaptureResult> {
  const { signal } = opts;
  let windowId: number | undefined;
  const closeWindow = () => {
    const id = windowId;
    windowId = undefined;
    return id === undefined ? Promise.resolve() : browser.windows.remove(id).catch(() => undefined);
  };
  // A fire-and-forget close for the paths where nothing can be awaited: abort and the page going away.
  const closeNow = () => void closeWindow();
  signal?.addEventListener("abort", closeNow, { once: true });
  if (typeof window !== "undefined") window.addEventListener("pagehide", closeNow);

  // The person closing the window or tab ends the capture at once rather than after a timeout.
  const inner = new AbortController();
  const sig = signal ? AbortSignal.any([signal, inner.signal]) : inner.signal;
  let watchedTab: number | undefined;
  let tabGone = false;
  const onTabRemoved = (id: number) => {
    if (id === watchedTab) {
      tabGone = true;
      inner.abort();
    }
  };
  browser.tabs.onRemoved.addListener(onTabRemoved);

  try {
    if (signal?.aborted) throw new Stop("aborted");
    if (url.length > MAX_URL_LENGTH) throw new Stop("blocked", "The link is too long.");
    const blockedSites = (await extensionStore.get<string[]>(KEYS.blockedSites)) ?? DEFAULT_BLOCKED_SITES;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Stop("blocked", "That isn't a web address.");
    }
    if (parsed.username || parsed.password || !isAllowedUrl(parsed.href, blockedSites)) {
      throw new Stop("blocked");
    }
    /** The page's current address must be allowed and on the same site; otherwise nothing of it is read. */
    const checkLanded = (landedUrl: string | undefined) => {
      if (!landedUrl || !isWeb(landedUrl)) throw new Stop("no-content", "The page did not load.");
      if (!isAllowedUrl(landedUrl, blockedSites)) {
        throw new Stop("blocked", "The page redirected to a blocked site or a private address.");
      }
      if (!sameSite(parsed.href, landedUrl)) throw new Stop("off-site", hostOf(landedUrl));
    };

    opts.onStatus?.("opening");
    // Not wrapped in `abortable`: if the Reader went away while the window was being made, the id
    // must still be recorded so the `finally` below closes it.
    windowId = await createScraperWindow(parsed.href);
    if (sig.aborted) throw new Stop("aborted");
    const tabs = await abortable(browser.tabs.query({ windowId }), sig);
    const tabId = tabs[0]?.id;
    if (tabId === undefined) throw new Stop("no-content", "The browser window had no tab.");
    watchedTab = tabId;
    // A page in a background window must not make noise.
    await browser.tabs.update(tabId, { muted: true }).catch(() => undefined);

    if (!(await abortable(pageLoaded(tabId, sig), sig))) {
      if (sig.aborted) throw new Stop("aborted");
      // Slow trackers can keep a page "loading" for minutes after the article is there.
      const slow = await browser.tabs.get(tabId).catch(() => null);
      const state = slow && isWeb(slow.url) ? await readyStateOf(tabId) : null;
      if (state !== "interactive" && state !== "complete") throw new Stop("timeout");
    }
    const landed = await browser.tabs.get(tabId).catch(() => null);
    if (!landed) throw new Stop("closed");
    checkLanded(landed.url);

    await pause(SETTLE_MS, sig);

    let raw: RawDocument | null = null;
    for (let attempt = 0; attempt < INJECT_ATTEMPTS && !raw; attempt++) {
      if (attempt > 0) await pause(INJECT_RETRY_MS, sig);
      try {
        raw = await abortable(readRawDocument(tabId), sig);
      } catch (err) {
        // A script that was started and ran out of time may still be scrolling: never start another.
        if (err instanceof Stop) throw err;
        // Otherwise the injection itself failed (the page may still be navigating); try again.
      }
    }
    if (!raw) throw new Stop("no-content", "The page could not be read.");
    if (raw.tooBig) throw new Stop("too-big");
    if (!raw.html.trim()) throw new Stop("no-content", "The page was empty.");
    // The page can redirect itself after it loaded: what it read goes nowhere unless it is still fine.
    checkLanded(raw.url);
    // The character count is a cheap lower bound on bytes; only a page near the limit is measured exactly.
    if (raw.html.length * 3 > MAX_IMPORT_BYTES && new TextEncoder().encode(raw.html).length > MAX_IMPORT_BYTES) {
      throw new Stop("too-big");
    }
    return { ok: true, html: raw.html, title: raw.title, finalUrl: raw.url };
  } catch (err) {
    if (signal?.aborted) return { ok: false, reason: "aborted" };
    if (tabGone) return { ok: false, reason: "closed" };
    if (err instanceof Stop) return { ok: false, reason: err.reason, detail: err.detail };
    return { ok: false, reason: "no-content", detail: err instanceof Error ? err.message.slice(0, 200) : undefined };
  } finally {
    browser.tabs.onRemoved.removeListener(onTabRemoved);
    signal?.removeEventListener("abort", closeNow);
    if (typeof window !== "undefined") window.removeEventListener("pagehide", closeNow);
    await closeWindow();
  }
}

/**
 * Ask the scraper content script, in raw-document mode, for the page. It scrolls first
 * (for at most about 8 s), so this takes a few seconds. Running out of time is a `Stop`;
 * any other error is an injection failure.
 */
async function readRawDocument(tabId: number): Promise<RawDocument | null> {
  const read = (async () => {
    // The flag and the script share the extension's isolated world in the tab, so it survives between the two calls.
    await browser.scripting.executeScript({
      target: { tabId },
      func: () => {
        (globalThis as { __rawDocument?: boolean }).__rawDocument = true;
      },
    });
    const injected = await browser.scripting.executeScript({
      target: { tabId },
      files: ["/content-scripts/scraper.js"],
    });
    return (injected?.[0]?.result as RawDocument | undefined) ?? null;
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Stop("no-content", "The page took too long to read.")), EXTRACT_TIMEOUT_MS);
  });
  try {
    return await Promise.race([read, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The whole job for the Reader: check Amber is there, open the page in the browser,
 * send what it returned to Amber, read the article text back. Never throws; failures
 * come back typed like `fetchFullArticle`'s. `title` is the headline the person
 * already sees (the feed's); without it Amber derives its own. A page that was
 * imported but could not be read back comes back as `saved-unreadable` with its
 * `id` and `meta`, so the caller can mark it saved and only re-read on a retry.
 */
export async function importFromBrowser(
  base: string,
  args: { url: string; title?: string },
  opts: { signal?: AbortSignal; onStatus?: (stage: FetchStage) => void } = {},
): Promise<FullArticleResult> {
  const { signal, onStatus } = opts;
  const stage = (s: FetchStage) => {
    if (!signal?.aborted) onStatus?.(s);
  };
  /** Read a snapshot that is in Amber. If that fails it is still saved: `saved-unreadable` carries its id. */
  const readBack = async (id: string, created: boolean, known: { title?: string; wordCount: number }) => {
    stage("reading");
    try {
      const { text, ...meta } = await readArticle(base, id, signal);
      return { ok: true, id, text, meta, created } satisfies FullArticleResult;
    } catch (err) {
      if (signal?.aborted) return { ok: false, reason: "aborted" } satisfies FullArticleResult;
      const host = hostOf(args.url);
      const root = normalizeArchiveUrl(base) ?? base;
      return {
        ok: false,
        reason: "saved-unreadable",
        detail: err instanceof ArticleFetchError ? err.detail : undefined,
        id,
        meta: {
          id,
          title: known.title ?? args.title ?? host,
          site: host,
          savedAt: new Date().toISOString(),
          wordCount: known.wordCount,
          paywalled: false,
          originalUrl: args.url,
          permalink: `${root}/${id}`,
        } satisfies ArchiveArticleMeta,
      } satisfies FullArticleResult;
    }
  };
  try {
    // A cheap, read-only look before a window opens: no point loading a page if Amber is not there,
    // and none if it already has a usable copy (an import never replaces one): read that instead.
    const found = await lookupArticle(base, args.url, signal);
    if (found.found && found.id && found.status === "complete" && found.usable) {
      return await readBack(found.id, false, { title: found.title, wordCount: 0 });
    }

    stage("browser-opening");
    const page = await captureWithBrowser(args.url, { signal });
    if (!page.ok) return { ok: false, reason: page.reason, detail: page.detail };
    if (signal?.aborted) return { ok: false, reason: "aborted" };

    stage("browser-sending");
    const imported = await importPage(
      base,
      { url: args.url, html: page.html, title: args.title, finalUrl: page.finalUrl },
      signal,
    );
    // Amber has saved the page but found no article in it: the publisher showed this browser a prompt too.
    if (!imported.usable) return { ok: false, reason: "paywall-stub", id: imported.id };
    // `existing` is a 409: a usable copy was archived meanwhile (or under the page's final address) and
    // nothing was stored. That copy is what to show; the story is marked like any other save.
    return await readBack(imported.id, !imported.existing, { title: imported.title, wordCount: imported.wordCount });
  } catch (err) {
    if (err instanceof ArticleFetchError) return { ok: false, reason: err.reason, detail: err.detail, id: err.id };
    if (signal?.aborted) return { ok: false, reason: "aborted" };
    return { ok: false, reason: "amber-down", detail: err instanceof Error ? err.message : String(err) };
  }
}
