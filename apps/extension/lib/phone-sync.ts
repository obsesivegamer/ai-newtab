import { normalizeArchiveUrl, type FeedSource } from "@homepage/agent-core";

/**
 * The extension and the phone/web version share two things through Amber (same
 * address, same origin for the web app): the built Today page and the sources
 * list. Amber only stores them. Everything here is best-effort: a failure is
 * logged and never blocks a build or a settings save.
 *
 *   GET/PUT /api/homepage  { code, timestamp, bytes? }
 *   GET/PUT /api/sources   { sources: [{ id, name, feedUrls, enabled }], updated_at }
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

function toSource(s: FeedSource) {
  return { id: s.id, name: s.name, feedUrls: [...s.feedUrls], enabled: s.enabled };
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

/** Publish the finished Today page for the phone. No-op without an archive address. */
export async function pushHomepage(archiveUrl: string, homepage: SharedHomepage): Promise<void> {
  const base = normalizeArchiveUrl(archiveUrl);
  if (!base) return;
  try {
    await putJson(`${base}/api/homepage`, { code: homepage.code, timestamp: homepage.timestamp });
  } catch (err) {
    console.warn("[phone-sync] couldn't publish the homepage to Amber:", err instanceof Error ? err.message : err);
  }
}

/** Publish the sources list so the phone reads the same publications. No-op without an archive address. */
export async function pushSources(archiveUrl: string, sources: FeedSource[]): Promise<void> {
  const base = normalizeArchiveUrl(archiveUrl);
  if (!base) return;
  try {
    await putJson(`${base}/api/sources`, { sources: sources.map(toSource) });
  } catch (err) {
    console.warn("[phone-sync] couldn't publish the sources to Amber:", err instanceof Error ? err.message : err);
  }
}

/** The Today page the extension published, if any. */
export async function fetchHomepage(base: string, signal?: AbortSignal): Promise<HomepageFetch> {
  let response: Response;
  try {
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    response = await fetch(`${base}/api/homepage`, {
      signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
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

/** The sources list stored in Amber, or null when there is none (or it can't be read). */
export async function fetchRemoteSources(base: string, signal?: AbortSignal): Promise<FeedSource[] | null> {
  try {
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    const response = await fetch(`${base}/api/sources`, {
      signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { sources?: unknown; updated_at?: unknown } | null;
    if (!body || !Array.isArray(body.sources)) return null;
    // An empty list counts only when someone saved it (updated_at set); a fresh Amber has neither.
    if (body.sources.length === 0 && !body.updated_at) return null;
    const out: FeedSource[] = [];
    const seen = new Set<string>();
    for (const entry of body.sources) {
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
    return out;
  } catch {
    return null;
  }
}
