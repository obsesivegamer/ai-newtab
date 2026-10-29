import { anySignal, normalizeArchiveUrl, type FeedSource } from "@homepage/agent-core";
import { IS_WEB } from "@/lib/platform";
import { archiveGetInit, type ArchiveAuth } from "./archive-auth";
import { parseRebuildRequest, type RebuildRequest } from "./rebuild-request";
import { saveSources } from "./sources";
import { KEYS } from "./storage";

/**
 * The extension and the phone/web version share two things through Amber (same
 * address, same origin for the web app): the built Today page and the sources
 * list. Amber only stores them. Everything here is best-effort: a failure is
 * logged and never blocks a build or a settings save.
 *
 *   GET/PUT /api/homepage  { code, timestamp, bytes? }
 *   GET/PUT /api/sources   { sources: [{ id, name, feedUrls, enabled }], updated_at }
 *
 * The sources list is last-write-wins unless a PUT carries `if_updated_at`: Amber
 * then writes only when its stored `updated_at` is that value, and otherwise answers
 * 409 with the stored list. Each device keeps the stamp it last saw (`KEYS.sourcesSyncStamp`).
 */

const TIMEOUT_MS = 10_000;

export interface SharedHomepage {
  /** The agent's raw TSX source. */
  code: string;
  /** ISO timestamp of when it was built. */
  timestamp: string;
  /** When the reader last copied this page from the Mac, if the response said. */
  syncedAt?: string;
  /** The reader's `rebuild_request` on GET, when it included one. `expired` is read from here. */
  rebuildRequest?: RebuildRequest;
}

export type HomepageFetch =
  | { status: "ok"; homepage: SharedHomepage }
  /** Amber is fine; nothing has been published yet. */
  | { status: "empty" }
  /** An Amber that does not have this endpoint (404 on the route itself). */
  | { status: "unsupported" }
  | { status: "error"; message: string };

export type RemoteSourcesResult =
  | { status: "list"; sources: FeedSource[]; updatedAt: string | null; readOnly: boolean }
  /** The reader refuses source edits and did not return a list (HTTP 405). */
  | { status: "read_only" }
  | { status: "unavailable" };

export type SourcesPublish =
  | { status: "ok" }
  /** Amber held a newer list: it has been adopted into storage (list and stamp) and is returned here. */
  | { status: "conflict"; sources: FeedSource[] }
  /** The reader refused the write. `sources` is the list it returned, when it returned one. */
  | { status: "read_only"; sources?: FeedSource[] }
  | { status: "skipped" | "failed" };

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/**
 * Whether `hostname` (as `new URL(...).hostname` gives it) is somewhere the Today page and
 * the sources list may be sent: loopback, a private IPv4 range, Tailscale's CGNAT range, or a
 * `*.ts.net` / `*.local` name. Both pushes use this, so what the extension publishes (titles
 * and blurbs from your reading) never goes to a public archive address.
 */
export function isShareableArchiveHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host === "[::1]") return true;
  const v4 = IPV4.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 127 ||
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  return host.endsWith(".ts.net") || host.endsWith(".local");
}

/**
 * The clean archive address to push to, or null. The extension pushes only to a shareable host
 * (above); the web app pushes only to the Amber that served it, which is not a setting.
 */
function shareTarget(archiveUrl: string): string | null {
  const base = normalizeArchiveUrl(archiveUrl);
  if (!base) return null;
  const host = new URL(base).hostname;
  if (IS_WEB || isShareableArchiveHost(host)) return base;
  console.warn(`[phone-sync] not sharing with ${host}: only local, private-network and tailnet addresses are used`);
  return null;
}

function toSource(s: FeedSource) {
  return { id: s.id, name: s.name, feedUrls: [...s.feedUrls], enabled: s.enabled };
}

/** Sources shaped like the catalog's, or null when `raw` isn't a list (or nothing in a non-empty one is usable). */
function cleanSources(raw: unknown): FeedSource[] | null {
  if (!Array.isArray(raw)) return null;
  const out: FeedSource[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const { id, name, feedUrls, enabled } = entry as Partial<FeedSource>;
    if (typeof id !== "string" || !id || typeof name !== "string" || !name || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name,
      feedUrls: Array.isArray(feedUrls) ? feedUrls.filter((u): u is string => typeof u === "string") : [],
      enabled: enabled !== false,
    });
  }
  return raw.length > 0 && out.length === 0 ? null : out;
}

/**
 * The stamp as last read or written in this page, so a push that must be issued inside `pagehide`
 * (no time for a storage read) can still carry its condition. `undefined`: not read yet.
 */
let stampCache: string | null | undefined;

/**
 * Amber answered 404 to the last read: it holds no list yet. A first push is then conditional on
 * "still none" (`if_updated_at: ""`), so it cannot overwrite a list another device wrote meanwhile.
 */
let amberHasNoSources = false;

/** The `updated_at` this device last saw from Amber for the sources list, if any. */
export async function loadSourcesStamp(): Promise<string | null> {
  const got = await browser.storage.local.get(KEYS.sourcesSyncStamp);
  const stamp: unknown = got[KEYS.sourcesSyncStamp];
  stampCache = typeof stamp === "string" && stamp ? stamp : null;
  return stampCache;
}

export async function saveSourcesStamp(stamp: string | null | undefined): Promise<void> {
  if (typeof stamp !== "string" || !stamp) return;
  stampCache = stamp;
  await browser.storage.local.set({ [KEYS.sourcesSyncStamp]: stamp });
}

async function putJson(url: string, body: unknown): Promise<void> {
  const response = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Amber answered ${response.status}`);
}

/** Publish the finished Today page for the phone. No-op without a shareable archive address. */
export async function pushHomepage(archiveUrl: string, homepage: SharedHomepage): Promise<void> {
  const base = shareTarget(archiveUrl);
  if (!base) return;
  try {
    await putJson(`${base}/api/homepage`, homepageBody(homepage));
  } catch (err) {
    console.warn("[phone-sync] couldn't publish the homepage to Amber:", err instanceof Error ? err.message : err);
  }
}

function homepageBody(homepage: SharedHomepage): { code: string; timestamp: string } {
  return { code: homepage.code, timestamp: homepage.timestamp };
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/**
 * Publish the finished page to the offline reader as well, so a phone on that
 * host sees it without waiting for the hourly copy. The timestamp is sent whole,
 * milliseconds included. An equal timestamp is accepted; an older one is 409 and
 * one more than 24h ahead is 422. Best-effort: a failure is logged and never
 * thrown. The reader password is attached only when this
 * request's origin is the reader and not the Mac. No-op without a shareable
 * reader address and a password, and when the reader is the Mac itself.
 */
export async function pushReaderHomepage(
  readerUrl: string,
  password: string,
  homepage: SharedHomepage,
  macUrl: string,
): Promise<void> {
  const base = shareTarget(readerUrl);
  if (!base || !password || (macUrl && sameOrigin(base, macUrl))) return;
  const url = `${base}/api/homepage`;
  const auth: ArchiveAuth = { macBase: macUrl, fallbackBase: base, password };
  const gated = archiveGetInit(url, auth);
  try {
    const headers = new Headers(gated.headers);
    headers.set("Content-Type", "application/json");
    const response = await fetch(url, {
      method: "PUT",
      headers,
      body: JSON.stringify(homepageBody(homepage)),
      redirect: gated.redirect,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`reader answered ${response.status}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : "request failed";
    console.warn(`[phone-sync] couldn't publish the homepage to the reader: ${message}`);
  }
}

/**
 * After a successful build, publish to the Mac archive and the reader. Either
 * failure stays inside its own call, so the reader cannot fail the Mac push.
 */
export async function publishBuiltHomepage(
  macBase: string | null,
  readerUrl: string,
  password: string,
  homepage: SharedHomepage,
): Promise<void> {
  await Promise.all([
    macBase ? pushHomepage(macBase, homepage) : Promise.resolve(),
    pushReaderHomepage(readerUrl, password, homepage, macBase ?? ""),
  ]);
}

export type RebuildPost =
  | { status: "ok"; request: RebuildRequest }
  | { status: "missing" }
  | { status: "error"; message: string };

/** What the phone shows when the rebuild POST fails. A missing status means the reader never answered. */
export function rebuildRequestError(status?: number): string {
  if (status === undefined) return "The reader didn't answer.";
  return `Couldn't ask your Mac to rebuild. The reader answered ${status}.`;
}

/**
 * Ask the reader to record a rebuild request for the Mac. The phone is served
 * by that reader, so this sends the session cookie and no Basic header. The
 * body is `{}` with `Content-Type: application/json`. A 404 means this Amber
 * has no such route. A cooldown object is still `"ok"`. `expired` on a POST is
 * not a result the phone branches on; that flag is read from GET.
 */
export async function requestHomepageRebuild(origin: string, signal?: AbortSignal): Promise<RebuildPost> {
  const base = normalizeArchiveUrl(origin);
  if (!base) return { status: "error", message: rebuildRequestError() };
  try {
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    const response = await fetch(`${base}/api/homepage/rebuild-request`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      credentials: "same-origin",
      signal: signal ? anySignal([timeout, signal]) : timeout,
    });
    if (response.status === 404) return { status: "missing" };
    if (!response.ok) return { status: "error", message: rebuildRequestError(response.status) };
    const request = parseRebuildRequest(await response.json().catch(() => null));
    return request ? { status: "ok", request } : { status: "error", message: rebuildRequestError(response.status) };
  } catch {
    return { status: "error", message: rebuildRequestError() };
  }
}

/**
 * Publish the sources list so the phone reads the same publications, conditional on the stamp
 * this device last saw (`ifUpdatedAt`, default: the stored one; null sends no condition). A 200
 * stores the new stamp. A 409 means another device wrote first: its list and stamp are adopted
 * into storage and returned, and nothing is retried. `keepalive` lets the request outlive a page
 * that is being closed. No-op without a shareable archive address; never throws.
 */
export async function publishSources(
  archiveUrl: string,
  sources: FeedSource[],
  opts: { ifUpdatedAt?: string | null; keepalive?: boolean } = {},
): Promise<SourcesPublish> {
  const base = shareTarget(archiveUrl);
  if (!base) return { status: "skipped" };
  try {
    // A keepalive push runs while the page is closing: use the cached stamp, with no await before the request.
    let stamp =
      opts.ifUpdatedAt !== undefined
        ? opts.ifUpdatedAt
        : opts.keepalive && stampCache !== undefined
          ? stampCache
          : await loadSourcesStamp();
    if (!stamp && opts.ifUpdatedAt === undefined && amberHasNoSources) stamp = "";
    const response = await fetch(`${base}/api/sources`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sources: sources.map(toSource), ...(typeof stamp === "string" ? { if_updated_at: stamp } : {}) }),
      keepalive: opts.keepalive || undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = (await response.json().catch(() => null)) as {
      sources?: unknown;
      updated_at?: unknown;
      read_only?: unknown;
    } | null;
    if (response.status === 405) {
      const theirs = cleanSources(body?.sources);
      return theirs ? { status: "read_only", sources: theirs } : { status: "read_only" };
    }
    if (response.ok) {
      amberHasNoSources = false;
      await saveSourcesStamp(typeof body?.updated_at === "string" ? body.updated_at : null);
      return { status: "ok" };
    }
    if (response.status === 409) {
      const theirs = cleanSources(body?.sources);
      if (theirs) {
        await saveSources(theirs);
        await saveSourcesStamp(typeof body?.updated_at === "string" ? body.updated_at : null);
        return { status: "conflict", sources: theirs };
      }
    }
    console.warn(`[phone-sync] couldn't publish the sources to Amber: Amber answered ${response.status}`);
  } catch (err) {
    console.warn("[phone-sync] couldn't publish the sources to Amber:", err instanceof Error ? err.message : err);
  }
  return { status: "failed" };
}

/** The Today page the extension published, if any. */
export async function fetchHomepage(base: string, signal?: AbortSignal): Promise<HomepageFetch> {
  let response: Response;
  try {
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    response = await fetch(`${base}/api/homepage`, {
      signal: signal ? anySignal([timeout, signal]) : timeout,
    });
  } catch (err) {
    return { status: "error", message: err instanceof Error ? err.message : String(err) };
  }
  if (response.status === 204) return { status: "empty" };
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    /* an error page or an empty body */
  }
  if (response.status === 404) {
    // Amber answers a stored-nothing 404 with a JSON detail; a bare/HTML 404 is an Amber without the route.
    const detail = (body as { detail?: unknown } | null)?.detail;
    return typeof detail === "string" && /no homepage/i.test(detail) ? { status: "empty" } : { status: "unsupported" };
  }
  if (!response.ok) return { status: "error", message: `Amber answered ${response.status}` };
  const { code, timestamp, synced_at, rebuild_request } = (body ?? {}) as {
    code?: unknown;
    timestamp?: unknown;
    synced_at?: unknown;
    rebuild_request?: unknown;
  };
  if (typeof code !== "string" || code.length === 0) return { status: "empty" };
  const homepage: SharedHomepage = { code, timestamp: typeof timestamp === "string" ? timestamp : "" };
  if (typeof synced_at === "string" && synced_at) homepage.syncedAt = synced_at;
  const request = parseRebuildRequest(rebuild_request);
  if (request) homepage.rebuildRequest = request;
  return { status: "ok", homepage };
}

/**
 * The sources list stored in Amber (with its stamp). `"read_only"` is a 405, or a
 * list the reader marked `read_only` without a usable catalog. `"unavailable"` is
 * a missing route, a failed read, or a server that has no list yet.
 */
export async function fetchRemoteSources(base: string, signal?: AbortSignal): Promise<RemoteSourcesResult> {
  try {
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    const response = await fetch(`${base}/api/sources`, {
      signal: signal ? anySignal([timeout, signal]) : timeout,
    });
    if (response.status === 404) {
      amberHasNoSources = true;
      return { status: "unavailable" };
    }
    const body = (await response.json().catch(() => null)) as {
      sources?: unknown;
      updated_at?: unknown;
      read_only?: unknown;
    } | null;
    if (response.status === 405) {
      const sources = cleanSources(body?.sources);
      const updatedAt = typeof body?.updated_at === "string" && body.updated_at ? body.updated_at : null;
      if (sources && (sources.length > 0 || updatedAt)) {
        return { status: "list", sources, updatedAt, readOnly: true };
      }
      return { status: "read_only" };
    }
    if (!response.ok) return { status: "unavailable" };
    amberHasNoSources = false;
    const readOnly = body?.read_only === true;
    const sources = cleanSources(body?.sources);
    if (!sources) return readOnly ? { status: "read_only" } : { status: "unavailable" };
    const updatedAt = typeof body?.updated_at === "string" && body.updated_at ? body.updated_at : null;
    // An empty list counts only when someone saved it (updated_at set); a fresh Amber has neither.
    if (sources.length === 0 && !updatedAt) return readOnly ? { status: "read_only" } : { status: "unavailable" };
    return { status: "list", sources, updatedAt, readOnly };
  } catch {
    return { status: "unavailable" };
  }
}
