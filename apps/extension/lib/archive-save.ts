import { normalizeArchiveUrl, type ArchiveArticle, type ArchiveArticleMeta } from "@homepage/agent-core";
import { createArchiveBridge } from "./archive";

/**
 * Saving an article to Amber on demand and reading its full text back: the
 * client for Amber's `/api/lookup`, `/api/save`, `/api/jobs/{id}` and
 * `/api/snapshots/{id}/text`, plus `POST /api/import` (`importPage`) for a page
 * this browser already loaded (lib/browser-capture.ts). Used by the Reader when
 * you open a story that is not in the archive yet.
 *
 * Client rules from Amber: only a snapshot that is `complete` and `usable` is
 * readable; a found-but-unusable one counts as not archived; the article link
 * is sent as-is (Amber normalizes both sides).
 */

/** Why a full article could not be had. `aborted` means the caller cancelled. */
export type FetchFailure =
  | "amber-down"
  | "no-api"
  | "busy"
  | "invalid-url"
  | "capture-failed"
  | "paywall-stub"
  | "not-saved"
  | "timeout"
  /** Amber refused an import as cross-site (403). */
  | "forbidden"
  /** The page is over Amber's import size limit (413, or over 12 MB before sending). */
  | "too-big"
  /** The address is on the blocked list or is not a public web address: the browser was not asked to open it. */
  | "blocked"
  /** The browser opened the page but handed back nothing to send. */
  | "no-content"
  /** The browser ended up on another site than the one asked for (usually a sign-in page). `detail` is its host. */
  | "off-site"
  /** The background window or tab was closed while the page was being read. */
  | "closed"
  /** Amber found the page's final address private or local and stored nothing (400 on `final_url`). */
  | "private-address"
  /** Amber took longer than the import's time limit; it may still finish. */
  | "import-timeout"
  /** Amber answered with a status no case here covers. `detail` says which. */
  | "amber-error"
  /** The import worked and the page is saved, but reading its text back failed. */
  | "saved-unreadable"
  | "aborted";

/** Where a fetch is up to, for a progress line. */
export type FetchStage =
  | "checking"
  | "saving"
  | "queued"
  | "capturing"
  | "reading"
  /** Browser capture: the page is open in a background window of the person's own browser. */
  | "browser-opening"
  /** Browser capture: the page's HTML is on its way to Amber. */
  | "browser-sending";

export class ArticleFetchError extends Error {
  constructor(
    readonly reason: FetchFailure,
    readonly detail?: string,
    /** The snapshot involved, when one exists (so a retry can pick it up). */
    readonly id?: string,
  ) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = "ArticleFetchError";
  }
}

export interface LookupResult {
  found: boolean;
  id?: string;
  /** queued | capturing | complete | failed */
  status?: string;
  usable?: boolean;
  title?: string;
  site?: string;
  url?: string;
  finalUrl?: string;
  createdAt?: string;
}

export type SaveResult =
  | { id: string; status: "exists"; usable: boolean }
  | { id: string; status: "queued" | "capturing" };

export type JobStatus = "queued" | "capturing" | "complete" | "failed";

/** Amber caps the lookup address at this many characters. */
export const MAX_URL_LENGTH = 2048;
export const POLL_INTERVAL_MS = 2_000;
export const POLL_CAP_MS = 90_000;
const REQUEST_TIMEOUT_MS = 12_000;
/** An import carries a whole page (up to 12 MB) and Amber extracts it before answering. */
const IMPORT_TIMEOUT_MS = 60_000;
/**
 * The most the import request body (the page, JSON-escaped, plus its addresses) may be.
 * Amber's own limit is 12 MiB; this stays under it so a 413 never has to be sent.
 */
export const MAX_IMPORT_BYTES = Math.floor(11.5 * 1024 * 1024);
/** Poll errors in a row before the capture is reported as unreachable. */
const POLL_ERROR_LIMIT = 3;

function baseOf(base: string): string {
  const normalized = normalizeArchiveUrl(base);
  if (!normalized) throw new ArticleFetchError("amber-down", "The archive address isn't valid.");
  return normalized;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new ArticleFetchError("aborted"));
    const timer = setTimeout(done, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new ArticleFetchError("aborted"));
    };
    function done() {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** One request to Amber, with its failure modes folded into `ArticleFetchError`. */
async function call(
  url: string,
  init: { method?: string; body?: unknown; rawBody?: string; signal?: AbortSignal; timeoutMs?: number },
): Promise<{ status: number; body: any }> {
  if (init.signal?.aborted) throw new ArticleFetchError("aborted");
  const timeout = AbortSignal.timeout(init.timeoutMs ?? REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, {
      method: init.method ?? "GET",
      headers:
        init.body === undefined && init.rawBody === undefined ? undefined : { "Content-Type": "application/json" },
      body: init.rawBody ?? (init.body === undefined ? undefined : JSON.stringify(init.body)),
      signal: init.signal ? AbortSignal.any([timeout, init.signal]) : timeout,
    });
  } catch (err) {
    if (init.signal?.aborted) throw new ArticleFetchError("aborted");
    // Only an import is given long enough that running out of time means "still working", not "down".
    if (init.timeoutMs !== undefined && timeout.aborted) throw new ArticleFetchError("import-timeout");
    throw new ArticleFetchError("amber-down", err instanceof Error ? err.message : String(err));
  }
  let body: any = null;
  try {
    body = await response.json();
  } catch {
    /* an error page or an empty body */
  }
  return { status: response.status, body };
}

const detailOf = (body: any): string | undefined =>
  typeof body?.detail === "string" ? body.detail.slice(0, 200) : undefined;

/** Fold an HTTP status from lookup/save into the failure it means. */
function failFor(status: number, body: any): ArticleFetchError {
  if (status === 400 || status === 413) return new ArticleFetchError("invalid-url", detailOf(body));
  if (status === 429) return new ArticleFetchError("busy", detailOf(body));
  // An Amber without the save API answers its catch-all for unknown /api paths with 404 or 405.
  if (status === 404 || status === 405 || status === 415) return new ArticleFetchError("no-api", detailOf(body));
  return new ArticleFetchError("amber-down", `Amber answered ${status}`);
}

/** Is this article already in the archive (any status)? */
export async function lookupArticle(base: string, url: string, signal?: AbortSignal): Promise<LookupResult> {
  if (url.length > MAX_URL_LENGTH) throw new ArticleFetchError("invalid-url", "The link is too long.");
  const root = baseOf(base);
  const { status, body } = await call(`${root}/api/lookup?url=${encodeURIComponent(url)}`, { signal });
  if (status !== 200) throw failFor(status, body);
  if (!body?.found) return { found: false };
  return {
    found: true,
    id: typeof body.id === "string" ? body.id : undefined,
    status: typeof body.status === "string" ? body.status : undefined,
    usable: body.usable === true,
    title: body.title ?? undefined,
    site: body.site ?? undefined,
    url: body.url ?? undefined,
    finalUrl: body.final_url ?? undefined,
    createdAt: body.created_at ?? undefined,
  };
}

/** Ask Amber to capture `url`. 200 means it already has it; 202 means a capture is queued or running. */
export async function saveArticle(
  base: string,
  url: string,
  opts: { force?: boolean; signal?: AbortSignal } = {},
): Promise<SaveResult> {
  if (url.length > MAX_URL_LENGTH) throw new ArticleFetchError("invalid-url", "The link is too long.");
  const root = baseOf(base);
  const { status, body } = await call(`${root}/api/save`, {
    method: "POST",
    body: opts.force ? { url, force: true } : { url },
    signal: opts.signal,
  });
  if ((status !== 200 && status !== 202) || typeof body?.id !== "string") throw failFor(status, body);
  if (body.status === "exists") return { id: body.id, status: "exists", usable: body.usable === true };
  return { id: body.id, status: body.status === "capturing" ? "capturing" : "queued" };
}

/**
 * Poll a capture until it finishes: about every 2 s, up to about 90 s. Resolves
 * when the job is `complete`; throws `capture-failed`, `timeout` or `aborted`.
 */
export async function waitForArticle(
  base: string,
  id: string,
  opts: { signal?: AbortSignal; onStatus?: (status: "queued" | "capturing") => void; intervalMs?: number; capMs?: number } = {},
): Promise<void> {
  const root = baseOf(base);
  const interval = opts.intervalMs ?? POLL_INTERVAL_MS;
  const deadline = Date.now() + (opts.capMs ?? POLL_CAP_MS);
  let errors = 0;
  for (;;) {
    let job: { status: number; body: any } | null = null;
    try {
      job = await call(`${root}/api/jobs/${encodeURIComponent(id)}`, { signal: opts.signal });
      errors = 0;
    } catch (err) {
      if (!(err instanceof ArticleFetchError) || err.reason === "aborted") throw err;
      // A blip while Amber is busy capturing is not a failed capture; give it a few tries.
      if (++errors >= POLL_ERROR_LIMIT) throw err;
    }
    if (job) {
      if (job.status === 404) throw new ArticleFetchError("capture-failed", "Amber lost track of the capture.", id);
      if (job.status !== 200) throw failFor(job.status, job.body);
      const state = job.body?.status as JobStatus | undefined;
      if (state === "complete") return;
      if (state === "failed") {
        const reason = typeof job.body?.error === "string" ? job.body.error.slice(0, 200) : undefined;
        throw new ArticleFetchError("capture-failed", reason, id);
      }
      opts.onStatus?.(state === "capturing" ? "capturing" : "queued");
    }
    if (Date.now() + interval > deadline) throw new ArticleFetchError("timeout", undefined, id);
    await sleep(interval, opts.signal);
  }
}

export interface ImportResult {
  id: string;
  /** Whether Amber could read an article out of the page (a paywall stub is saved but not usable). */
  usable: boolean;
  wordCount: number;
  title?: string;
  /** Amber already had a usable copy (409): `id` is that copy, nothing was replaced. */
  existing?: boolean;
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
/** A string with every lone surrogate replaced by U+FFFD, so it survives UTF-8 and Amber's Python. */
function wellFormed(text: string): string {
  const native = (text as string & { toWellFormed?: () => string }).toWellFormed;
  return typeof native === "function" ? native.call(text) : text.replace(LONE_SURROGATE, "\uFFFD");
}

/**
 * Hand Amber a page's HTML that this browser already loaded (signed in), so the
 * capture does not depend on Amber's own anonymous fetch. `POST /api/import`; the
 * new snapshot becomes the newest for `url`. A 409 means a usable copy exists
 * already and is returned as `existing` (`force` is never sent). `finalUrl` is where the page ended up
 * after redirects; Amber resolves and validates it like `url` and answers 400 when
 * it is private. Throws `ArticleFetchError`.
 */
export async function importPage(
  base: string,
  page: { url: string; html: string; title?: string; finalUrl?: string },
  signal?: AbortSignal,
): Promise<ImportResult> {
  if (page.url.length > MAX_URL_LENGTH) throw new ArticleFetchError("invalid-url", "The link is too long.");
  const root = baseOf(base);
  const body: { url: string; html: string; title?: string; final_url?: string } = {
    url: page.url,
    html: wellFormed(page.html),
  };
  if (page.title) body.title = wellFormed(page.title);
  if (page.finalUrl) body.final_url = page.finalUrl;
  const rawBody = JSON.stringify(body);
  // The request is what has to fit, not just the page: JSON escaping and UTF-8 make it larger.
  if (new TextEncoder().encode(rawBody).length > MAX_IMPORT_BYTES) throw new ArticleFetchError("too-big");
  const { status, body: reply } = await call(`${root}/api/import`, {
    method: "POST",
    rawBody,
    signal,
    timeoutMs: IMPORT_TIMEOUT_MS,
  });
  if (status === 201 && typeof reply?.id === "string") {
    return {
      id: reply.id,
      usable: reply.usable === true,
      wordCount: typeof reply.word_count === "number" ? reply.word_count : 0,
      title: typeof reply.title === "string" ? reply.title : undefined,
    };
  }
  // 409: a usable copy of this story (or of its final address) is already archived. An import never
  // replaces a usable copy, so this is a success: the existing snapshot is what to read.
  if (status === 409 && typeof reply?.id === "string") {
    return { id: reply.id, usable: true, wordCount: 0, existing: true };
  }
  const detail = detailOf(reply);
  if (status === 400 && page.finalUrl && detail && /private|local|final_url/i.test(detail)) {
    throw new ArticleFetchError("private-address", detail);
  }
  // 422: Amber took the page but could not turn it into a snapshot.
  if (status === 400 || status === 422) throw new ArticleFetchError("invalid-url", detail);
  if (status === 403) throw new ArticleFetchError("forbidden", detail);
  // An Amber without the import API answers its catch-all for unknown /api paths with 404 or 405.
  if (status === 404 || status === 405) throw new ArticleFetchError("no-api", detail);
  if (status === 413) throw new ArticleFetchError("too-big", detail);
  if (status === 429) throw new ArticleFetchError("busy", detail);
  throw new ArticleFetchError("amber-error", `Amber answered ${status}`);
}

/** The text of a snapshot. A 404 means Amber has no readable article behind it (a paywall stub). */
export async function readArticle(base: string, id: string, signal?: AbortSignal): Promise<ArchiveArticle> {
  let result: Awaited<ReturnType<ReturnType<typeof createArchiveBridge>["getArticles"]>>;
  try {
    result = await createArchiveBridge(base).getArticles({ ids: [id], signal });
  } catch (err) {
    if (signal?.aborted) throw new ArticleFetchError("aborted");
    throw new ArticleFetchError("amber-down", err instanceof Error ? err.message : String(err), id);
  }
  const article = result.articles[0];
  if (article) return article;
  if (signal?.aborted) throw new ArticleFetchError("aborted");
  const reason = result.failed[0]?.reason ?? "";
  if (/responded 404/.test(reason)) throw new ArticleFetchError("paywall-stub", undefined, id);
  throw new ArticleFetchError("amber-down", reason.slice(0, 200), id);
}

export type FullArticleResult =
  | {
      ok: true;
      id: string;
      text: string;
      meta: ArchiveArticleMeta;
      /** True when a capture finished during this call, started by it or already running (so the archive list has a new article). */
      created: boolean;
    }
  | {
      ok: false;
      reason: FetchFailure;
      detail?: string;
      id?: string;
      /** With `saved-unreadable`: the snapshot that now exists, for the "In Amber" marker. */
      meta?: ArchiveArticleMeta;
    };

/**
 * The whole job: lookup, then read it if it is readable, else save, wait and
 * read. Never throws; failures come back typed. `force` re-captures an article
 * Amber has only a stub of. `saveIfMissing: false` stops after the lookup with
 * `not-saved` instead of starting a capture; a capture that is already queued or
 * running is waited for either way (polling it changes nothing in Amber).
 */
export async function fetchFullArticle(
  base: string,
  args: { url: string; force?: boolean; saveIfMissing?: boolean },
  opts: { signal?: AbortSignal; onStatus?: (stage: FetchStage) => void } = {},
): Promise<FullArticleResult> {
  const { signal, onStatus } = opts;
  const stage = (s: FetchStage) => {
    if (!signal?.aborted) onStatus?.(s);
  };
  const finish = (article: ArchiveArticle, created: boolean): FullArticleResult => {
    const { text, ...meta } = article;
    return { ok: true, id: article.id, text, meta, created };
  };
  try {
    stage("checking");
    const found = await lookupArticle(base, args.url, signal);

    if (found.found && found.id && found.status === "complete" && found.usable) {
      stage("reading");
      return finish(await readArticle(base, found.id, signal), false);
    }
    if (found.found && found.id && found.status === "complete" && !found.usable && !args.force) {
      // Amber has this page but it is not an article (a paywall stub). Re-capturing is the person's call.
      throw new ArticleFetchError("paywall-stub", undefined, found.id);
    }
    if (found.found && found.id && (found.status === "queued" || found.status === "capturing")) {
      // A capture is already under way (this page started it earlier, or another tab did). Watching
      // it is read-only: it asks Amber nothing new, so it needs no permission to save.
      stage(found.status);
      await waitForArticle(base, found.id, { signal, onStatus: stage });
      stage("reading");
      return finish(await readArticle(base, found.id, signal), true);
    }
    if (args.saveIfMissing === false) throw new ArticleFetchError("not-saved", undefined, found.id);

    stage("saving");
    const saved = await saveArticle(base, args.url, { force: args.force, signal });
    let created = true;
    if (saved.status === "exists") {
      created = false;
      if (!saved.usable) throw new ArticleFetchError("paywall-stub", undefined, saved.id);
    } else {
      stage(saved.status);
      await waitForArticle(base, saved.id, { signal, onStatus: stage });
    }
    stage("reading");
    return finish(await readArticle(base, saved.id, signal), created);
  } catch (err) {
    if (err instanceof ArticleFetchError) return { ok: false, reason: err.reason, detail: err.detail, id: err.id };
    if (signal?.aborted) return { ok: false, reason: "aborted" };
    return { ok: false, reason: "amber-down", detail: err instanceof Error ? err.message : String(err) };
  }
}
