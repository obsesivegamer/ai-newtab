import { DEFAULT_BLOCKED_SITES, isAllowedUrl } from "@homepage/agent-core";
import {
  ArticleFetchError,
  MAX_IMPORT_BYTES,
  MAX_URL_LENGTH,
  importPage,
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
 */

const LOAD_TIMEOUT_MS = 30_000;
/** After load, let a single-page app render before the page is scrolled and read. */
const SETTLE_MS = 2_000;
/** The scroll-and-read script has this long, once the page has loaded. */
const EXTRACT_TIMEOUT_MS = 45_000;
const EXTRACT_ATTEMPTS = 3;
const EXTRACT_RETRY_MS = 1_000;

/** What `entrypoints/scraper.content.ts` hands back when it was asked for the raw document. */
interface RawDocument {
  url: string;
  title: string;
  html: string;
  tooBig?: boolean;
}

export type BrowserCaptureStage = "opening" | "reading";

export type BrowserCaptureResult =
  | {
      ok: true;
      /** The page's untouched `document.documentElement.outerHTML`, at most 12 MB. */
      html: string;
      title: string;
      /** Where the page ended up after redirects. */
      finalUrl: string;
    }
  | { ok: false; reason: Extract<FetchFailure, "blocked" | "timeout" | "no-content" | "too-big" | "aborted">; detail?: string };

class Stop extends Error {
  constructor(
    readonly reason: Extract<FetchFailure, "blocked" | "timeout" | "no-content" | "too-big" | "aborted">,
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

/** True once the tab has finished loading a web page. Also true when it finished before we looked. */
async function pageLoaded(tabId: number, signal?: AbortSignal): Promise<boolean> {
  const stop = new AbortController();
  const wait = waitForTabLoad(tabId, LOAD_TIMEOUT_MS, signal ? AbortSignal.any([signal, stop.signal]) : stop.signal);
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

/**
 * Open `url` in a background window of the person's own browser (their cookies and
 * subscriptions apply), let it settle, scroll it the way the scraper does to wake
 * lazy content, and return the document's raw HTML for Amber's extractor. Never
 * throws: failures come back typed. The window is closed on every path, also when
 * `signal` aborts or the new-tab page is closed.
 *
 * Refuses (without opening anything) a link that is not http(s), is on a
 * loopback, private or local-network host, or is on the person's blocked-sites
 * list; the page's final address after redirects is checked again before its HTML
 * is returned. Neither URLs nor HTML are logged.
 */
export async function captureWithBrowser(
  url: string,
  opts: {
    signal?: AbortSignal;
    onStatus?: (stage: BrowserCaptureStage) => void;
    /** Overrides the stored blocked-sites list (the default is read fresh from storage). */
    blockedSites?: string[];
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

  try {
    if (signal?.aborted) throw new Stop("aborted");
    if (url.length > MAX_URL_LENGTH) throw new Stop("blocked", "The link is too long.");
    const blockedSites =
      opts.blockedSites ?? (await extensionStore.get<string[]>(KEYS.blockedSites)) ?? DEFAULT_BLOCKED_SITES;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Stop("blocked", "That isn't a web address.");
    }
    if (parsed.username || parsed.password || !isAllowedUrl(parsed.href, blockedSites)) {
      throw new Stop("blocked");
    }

    opts.onStatus?.("opening");
    // Not wrapped in `abortable`: an id that is dropped would be a window nobody closes.
    windowId = await createScraperWindow(parsed.href);
    if (signal?.aborted) throw new Stop("aborted");
    const tabs = await abortable(browser.tabs.query({ windowId }), signal);
    const tabId = tabs[0]?.id;
    if (tabId === undefined) throw new Stop("no-content", "The browser window had no tab.");

    if (!(await abortable(pageLoaded(tabId, signal), signal))) {
      if (signal?.aborted) throw new Stop("aborted");
      throw new Stop("timeout");
    }
    const landed = await browser.tabs.get(tabId).catch(() => null);
    if (!landed || !isWeb(landed.url)) throw new Stop("no-content", "The page did not load.");

    await pause(SETTLE_MS, signal);
    opts.onStatus?.("reading");

    let raw: RawDocument | null = null;
    for (let attempt = 0; attempt < EXTRACT_ATTEMPTS && !raw; attempt++) {
      if (attempt > 0) await pause(EXTRACT_RETRY_MS, signal);
      try {
        raw = await abortable(readRawDocument(tabId), signal);
      } catch (err) {
        if (err instanceof Stop) throw err;
        // The page may still be navigating; try again.
      }
    }
    if (!raw) throw new Stop("no-content", "The page could not be read.");
    if (raw.tooBig) throw new Stop("too-big");
    if (!raw.html.trim()) throw new Stop("no-content", "The page was empty.");
    // A redirect can end on a blocked host: the browser loaded it, but nothing it read goes anywhere.
    if (!isAllowedUrl(raw.url, blockedSites)) throw new Stop("blocked", "The page redirected to a blocked site.");
    // The character count is a cheap lower bound on bytes; only a page near the limit is measured exactly.
    if (raw.html.length * 3 > MAX_IMPORT_BYTES && new TextEncoder().encode(raw.html).length > MAX_IMPORT_BYTES) {
      throw new Stop("too-big");
    }
    return { ok: true, html: raw.html, title: raw.title, finalUrl: raw.url };
  } catch (err) {
    if (err instanceof Stop) return { ok: false, reason: err.reason, detail: err.detail };
    if (signal?.aborted) return { ok: false, reason: "aborted" };
    return { ok: false, reason: "no-content", detail: err instanceof Error ? err.message.slice(0, 200) : undefined };
  } finally {
    signal?.removeEventListener("abort", closeNow);
    if (typeof window !== "undefined") window.removeEventListener("pagehide", closeNow);
    await closeWindow();
  }
}

/** Ask the scraper content script, in raw-document mode, for the page. Scrolls first, so it takes a few seconds. */
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
    timer = setTimeout(() => reject(new Error("reading the page took too long")), EXTRACT_TIMEOUT_MS);
  });
  try {
    return await Promise.race([read, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The whole job for the Reader: open the page in the browser, send what it
 * returned to Amber, read the article text back. Never throws; failures come
 * back typed like `fetchFullArticle`'s. `title` is the headline the person
 * already sees (the feed's); without it Amber derives its own.
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
  try {
    stage("browser-opening");
    const page = await captureWithBrowser(args.url, { signal, onStatus: () => stage("browser-opening") });
    if (!page.ok) return { ok: false, reason: page.reason, detail: page.detail };
    if (signal?.aborted) return { ok: false, reason: "aborted" };

    stage("browser-sending");
    const imported = await importPage(base, { url: args.url, html: page.html, title: args.title }, signal);
    // Amber has saved the page but found no article in it: the publisher showed this browser a prompt too.
    if (!imported.usable) return { ok: false, reason: "paywall-stub", id: imported.id };

    stage("reading");
    const { text, ...meta } = await readArticle(base, imported.id, signal);
    return { ok: true, id: imported.id, text, meta, created: true };
  } catch (err) {
    if (err instanceof ArticleFetchError) return { ok: false, reason: err.reason, detail: err.detail, id: err.id };
    if (signal?.aborted) return { ok: false, reason: "aborted" };
    return { ok: false, reason: "amber-down", detail: err instanceof Error ? err.message : String(err) };
  }
}
