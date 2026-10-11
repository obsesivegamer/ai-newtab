import { anySignal, normalizeArchiveUrl, type FeedSource } from "@homepage/agent-core";
import { IS_WEB } from "@/lib/platform";
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
}

export type HomepageFetch =
  | { status: "ok"; homepage: SharedHomepage }
  /** Amber is fine; nothing has been published yet. */
  | { status: "empty" }
  /** An Amber that does not have this endpoint (404 on the route itself). */
  | { status: "unsupported" }
  | { status: "error"; message: string };

export interface RemoteSources {
  sources: FeedSource[];
  /** Amber's `updated_at` for this list, when it gave one. */
  updatedAt: string | null;
}

export type SourcesPublish =
  | { status: "ok" }
  /** Amber held a newer list: it has been adopted into storage (list and stamp) and is returned here. */
  | { status: "conflict"; sources: FeedSource[] }
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
    await putJson(`${base}/api/homepage`, { code: homepage.code, timestamp: homepage.timestamp });
  } catch (err) {
    console.warn("[phone-sync] couldn't publish the homepage to Amber:", err instanceof Error ? err.message : err);
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
    const stamp =
      opts.ifUpdatedAt !== undefined
        ? opts.ifUpdatedAt
        : opts.keepalive && stampCache !== undefined
          ? stampCache
          : await loadSourcesStamp();
    const response = await fetch(`${base}/api/sources`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sources: sources.map(toSource), ...(stamp ? { if_updated_at: stamp } : {}) }),
      keepalive: opts.keepalive || undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = (await response.json().catch(() => null)) as { sources?: unknown; updated_at?: unknown } | null;
    if (response.ok) {
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
  const { code, timestamp } = (body ?? {}) as { code?: unknown; timestamp?: unknown };
  if (typeof code !== "string" || code.length === 0) return { status: "empty" };
  return {
    status: "ok",
    homepage: { code, timestamp: typeof timestamp === "string" ? timestamp : "" },
  };
}

/** The sources list stored in Amber (with its stamp), or null when there is none or it can't be read. */
export async function fetchRemoteSources(base: string, signal?: AbortSignal): Promise<RemoteSources | null> {
  try {
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    const response = await fetch(`${base}/api/sources`, {
      signal: signal ? anySignal([timeout, signal]) : timeout,
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { sources?: unknown; updated_at?: unknown } | null;
    const sources = cleanSources(body?.sources);
    if (!sources) return null;
    const updatedAt = typeof body?.updated_at === "string" && body.updated_at ? body.updated_at : null;
    // An empty list counts only when someone saved it (updated_at set); a fresh Amber has neither.
    if (sources.length === 0 && !updatedAt) return null;
    return { sources, updatedAt };
  } catch {
    return null;
  }
}
