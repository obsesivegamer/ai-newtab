import { normalizeArchiveUrl } from "@homepage/agent-core";
import { archiveGetInit, type ArchiveAuth } from "./archive-auth";

/**
 * How often the worker may ask the reader whether the phone wants a rebuild.
 * The heartbeat alarm is one minute and can fire a little early; 50s lets each
 * alarm through, and a second tick sooner than that does not ask again.
 */
export const REBUILD_POLL_MIN_MS = 50_000;

/**
 * The reader check gives up quickly. It runs beside the scheduled rebuild, so a
 * reader that never answers must not hold that rebuild up.
 */
export const REBUILD_POLL_TIMEOUT_MS = 2_500;

/** How many request ids to remember. A request is only open for about 15 minutes. */
const HANDLED_REBUILD_CAP = 32;

/** Shown once when the reader rejects the password. The password itself is never included. */
export const READER_AUTH_MESSAGE = "The offline reader rejected the password. Check it in Settings.";

/**
 * `GET`/`POST /api/homepage/rebuild-request`. The reader fills `fulfilled_at`
 * on its own clock when a page newer than `baseline_timestamp` arrives.
 * `cooldown` means a fulfilled request is still inside the quiet period.
 * `expired` means an open request was left unfulfilled too long.
 */
export interface RebuildRequest {
  requestedAt: string;
  id: string;
  fulfilledAt: string | null;
  baselineTimestamp: string | null;
  expired: boolean;
  cooldown: boolean;
}

export type RebuildRequestFetch =
  | { status: "ready"; request: RebuildRequest }
  | { status: "none" }
  | { status: "missing" }
  | { status: "unauthorized" }
  | { status: "error" };

export function parseRebuildRequest(body: unknown): RebuildRequest | null {
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  const id = record.id;
  if (typeof id !== "string" || !id.trim()) return null;
  const requestedAt = typeof record.requested_at === "string" ? record.requested_at : "";
  const fulfilledAt = typeof record.fulfilled_at === "string" && record.fulfilled_at ? record.fulfilled_at : null;
  const baselineTimestamp =
    typeof record.baseline_timestamp === "string" && record.baseline_timestamp ? record.baseline_timestamp : null;
  return {
    requestedAt,
    id: id.trim(),
    fulfilledAt,
    baselineTimestamp,
    expired: record.expired === true,
    cooldown: record.cooldown === true,
  };
}

/**
 * `GET /api/homepage/rebuild-request` on the reader. Basic auth goes out only
 * when `archiveGetInit` attaches it (reader origin, not the Mac). A 404 means
 * the route is not there. A 401 is a wrong password, not a missing route.
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
    const response = await fetch(url, { ...gated, signal: AbortSignal.timeout(REBUILD_POLL_TIMEOUT_MS) });
    if (response.status === 404) return { status: "missing" };
    if (response.status === 401) return { status: "unauthorized" };
    if (!response.ok) return { status: "error" };
    const request = parseRebuildRequest(await response.json().catch(() => null));
    return request ? { status: "ready", request } : { status: "none" };
  } catch {
    return { status: "error" };
  }
}

export function canPollRebuildRequest(input: {
  running: boolean;
  readerConfigured: boolean;
  hasApiKey: boolean;
  autoRebuild: boolean;
  authRejected: boolean;
}): boolean {
  return !input.running && input.readerConfigured && input.hasApiKey && input.autoRebuild && !input.authRejected;
}

export function shouldPollRebuildRequest(
  input: {
    now: number;
    lastPollAt: number;
  } & Parameters<typeof canPollRebuildRequest>[0],
): boolean {
  return canPollRebuildRequest(input) && input.now - input.lastPollAt >= REBUILD_POLL_MIN_MS;
}

/**
 * The notice to keep while a 401 has paused polling. A worker restart begins
 * with no in-memory notice; the stored fingerprint is what puts the banner back.
 * A changed password drops it. Any other notice is left alone.
 */
export function persistedReaderAuthNotice(
  storedFingerprint: string | undefined,
  fingerprint: string,
  current: string | null,
): string | null {
  if (readerAuthStillRejected(storedFingerprint, fingerprint)) return READER_AUTH_MESSAGE;
  return current === READER_AUTH_MESSAGE ? null : current;
}

/** True when this password is the one the reader already rejected. */
export function readerAuthStillRejected(storedFingerprint: string | undefined, fingerprint: string): boolean {
  return Boolean(storedFingerprint && fingerprint && storedFingerprint === fingerprint);
}

/** The line to show for a 401, or null when this password was already reported. */
export function readerAuthNotice(alreadyRejected: boolean): string | null {
  return alreadyRejected ? null : READER_AUTH_MESSAGE;
}

/**
 * A short id for the password so a later change can poll again. The password
 * itself stays in the settings key and is not written a second time.
 */
export async function passwordFingerprint(password: string): Promise<string> {
  const bytes = new TextEncoder().encode(password);
  try {
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].slice(0, 8).map((byte) => byte.toString(16).padStart(2, "0")).join("");
  } catch {
    let hash = 5381;
    for (const byte of bytes) hash = ((hash * 33) ^ byte) >>> 0;
    return hash.toString(16);
  }
}

export function normalizeHandledRebuildIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((id): id is string => typeof id === "string" && id.length > 0);
}

/** Remember `id` once, dropping the oldest past the cap. */
export function rememberRebuildRequestId(handled: readonly string[], id: string): string[] {
  const next = handled.filter((item) => item !== id);
  next.push(id);
  return next.slice(-HANDLED_REBUILD_CAP);
}

/**
 * One build per unseen id whose `fulfilled_at` is null. Cooldown and expired
 * requests are not work. Nothing here compares the reader clock with the Mac.
 * `"remember"` means a build is already running, so the id is claimed and no
 * second build is started.
 */
export function rebuildTickAction(input: {
  running: boolean;
  request: RebuildRequestFetch;
  handledIds: readonly string[];
}): "start" | "remember" | "skip" {
  if (input.request.status !== "ready") return "skip";
  const { request } = input.request;
  if (request.cooldown || request.expired || request.fulfilledAt) return "skip";
  if (!request.id || input.handledIds.includes(request.id)) return "skip";
  return input.running ? "remember" : "start";
}
