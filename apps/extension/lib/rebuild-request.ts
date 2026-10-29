import { normalizeArchiveUrl } from "@homepage/agent-core";
import { archiveGetInit, type ArchiveAuth } from "./archive-auth";

/** How often the worker may ask the reader whether the phone wants a rebuild. */
export const REBUILD_POLL_MIN_MS = 60_000;

const TIMEOUT_MS = 10_000;

export type RebuildRequestFetch =
  | { status: "ready"; requestedAt: string }
  | { status: "none" }
  | { status: "missing" }
  | { status: "error" };

/**
 * `GET /api/homepage/rebuild-request` on the reader. Basic auth goes out only
 * when `archiveGetInit` attaches it (reader origin, not the Mac). A 404 means
 * the route is not there; the caller treats that as no feature.
 */
export async function fetchRebuildRequest(
  readerUrl: string,
  password: string,
  macUrl: string,
): Promise<RebuildRequestFetch> {
  const base = normalizeArchiveUrl(readerUrl);
  if (!base || !password) return { status: "none" };
  const url = `${base}/api/homepage/rebuild-request`;
  const auth: ArchiveAuth = { macBase: macUrl, fallbackBase: base, password };
  const gated = archiveGetInit(url, auth);
  try {
    const response = await fetch(url, { ...gated, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (response.status === 404) return { status: "missing" };
    if (!response.ok) return { status: "error" };
    const body = (await response.json().catch(() => null)) as { requested_at?: unknown } | null;
    const requestedAt = body?.requested_at;
    if (typeof requestedAt !== "string" || !requestedAt) return { status: "none" };
    return { status: "ready", requestedAt };
  } catch {
    return { status: "error" };
  }
}

export function shouldPollRebuildRequest(input: {
  running: boolean;
  now: number;
  lastPollAt: number;
  readerConfigured: boolean;
}): boolean {
  if (input.running || !input.readerConfigured) return false;
  return input.now - input.lastPollAt >= REBUILD_POLL_MIN_MS;
}

/**
 * A phone request starts a build when its `requested_at` is strictly newer than
 * the last successful build and the last attempt. That ignores the auto-rebuild
 * interval and the failure backoff. A build already in progress does not start
 * another. A missing timestamp counts as older than the request.
 */
export function shouldStartRequestedRebuild(input: {
  running: boolean;
  requestedAt: string;
  lastBuildTimestamp?: string | null;
  lastAttemptTimestamp?: string | null;
}): boolean {
  if (input.running) return false;
  const requested = Date.parse(input.requestedAt);
  if (!Number.isFinite(requested)) return false;
  const newerThan = (iso?: string | null) => {
    if (!iso) return true;
    const at = Date.parse(iso);
    return !Number.isFinite(at) || requested > at;
  };
  return newerThan(input.lastBuildTimestamp) && newerThan(input.lastAttemptTimestamp);
}

/** What `BuildManager.tick` does with one reader poll. `"missing"` is a 404. */
export function rebuildTickAction(input: {
  running: boolean;
  request: RebuildRequestFetch;
  lastBuildTimestamp?: string | null;
  lastAttemptTimestamp?: string | null;
}): "start" | "skip" {
  if (input.running || input.request.status !== "ready") return "skip";
  return shouldStartRequestedRebuild({
    running: false,
    requestedAt: input.request.requestedAt,
    lastBuildTimestamp: input.lastBuildTimestamp,
    lastAttemptTimestamp: input.lastAttemptTimestamp,
  })
    ? "start"
    : "skip";
}
