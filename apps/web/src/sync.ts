import type { FeedSource } from "@homepage/agent-core";
import { fetchRemoteSources, loadSourcesStamp, publishSources, saveSourcesStamp } from "@/lib/phone-sync";
import { saveSources } from "@/lib/sources";

/**
 * Sources are shared with the extension through Amber (`/api/sources`). On load the
 * list Amber holds wins when it has one; without it the page seeds from the archive
 * like the extension does (`loadSources`). Edits are written locally at once and
 * pushed back after a short pause, so tapping a few switches sends one request.
 *
 * Every push says which version of Amber's list it was based on (`if_updated_at`, the
 * stamp this device last saw). If another device wrote first Amber refuses, and its list
 * is adopted instead (`onSourcesAdopted`). The same list is re-read when Settings opens
 * and when the page becomes visible again, so a phone left open picks up Mac edits.
 */

export type AdoptReason = "conflict" | "refresh";
type Listener = (sources: FeedSource[], reason: AdoptReason) => void;

const listeners = new Set<Listener>();

/** Called whenever the list was replaced by the one Amber holds (not for the boot read, which precedes the UI). */
export function onSourcesAdopted(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function announce(sources: FeedSource[], reason: AdoptReason): void {
  for (const listener of listeners) listener(sources, reason);
}

/** Adopt Amber's list as this device's list. Returns whether one was found; a failed read changes nothing. */
export async function adoptRemoteSources(origin: string, signal?: AbortSignal): Promise<boolean> {
  await loadSourcesStamp();
  const remote = await fetchRemoteSources(origin, signal);
  if (!remote) return false;
  await saveSources(remote.sources);
  await saveSourcesStamp(remote.updatedAt);
  return true;
}

const PUSH_DELAY_MS = 800;
let timer: ReturnType<typeof setTimeout> | undefined;
let pending: { origin: string; sources: FeedSource[] } | null = null;
/** Pushes run one at a time, so a second never carries the stamp the first is about to replace. */
let inflight: Promise<void> = Promise.resolve();
/** A feed is being probed in Settings: don't swap the list under it. */
let probing = false;

/** Settings sets this while it checks a feed address, so a re-read doesn't land in the middle of it. */
export function holdRemoteRefresh(hold: boolean): void {
  probing = hold;
}

/** Own pushes not yet answered: a page-hide push can't know the stamp they are about to produce. */
let unanswered = 0;

function send(origin: string, sources: FeedSource[], keepalive: boolean): void {
  const run = async (ifUpdatedAt?: null) => {
    unanswered++;
    try {
      const result = await publishSources(origin, sources, { keepalive, ifUpdatedAt });
      if (result.status === "conflict") announce(result.sources, "conflict");
    } finally {
      unanswered--;
    }
  };
  if (keepalive) {
    // Runs now (the page is going away). If an earlier push of ours is still in flight, the stamp we
    // hold is about to be stale because of our own write, so send without a condition rather than
    // meeting our own 409 and adopting the older list. Joins the queue so a later refresh waits for it.
    const own = run(unanswered > 0 ? null : undefined);
    inflight = inflight.then(() => own, () => own);
    return;
  }
  inflight = inflight.then(() => run(), () => run());
}

/** Save a person's edit locally, then send it to Amber once edits have paused. */
export function saveAndPushSources(origin: string, sources: FeedSource[]): Promise<void> {
  clearTimeout(timer);
  pending = { origin, sources };
  timer = setTimeout(() => flushSourcePush(), PUSH_DELAY_MS);
  return saveSources(sources);
}

/**
 * Send a pending edit now (the settings sheet is closing, or the page is being hidden).
 * `keepalive` lets the request finish after the page is gone.
 */
export function flushSourcePush(keepalive = false): void {
  clearTimeout(timer);
  const edit = pending;
  pending = null;
  if (edit) send(edit.origin, edit.sources, keepalive);
}

/**
 * Re-read Amber's list and adopt it when its stamp differs from the one this device last saw.
 * Our own unsent edits go first, so they are never mistaken for someone else's; an edit made
 * while the read was in flight keeps priority (its push will meet Amber's 409 if it is stale).
 * Best-effort: any failure leaves everything as it was.
 */
export async function refreshRemoteSources(origin: string): Promise<void> {
  if (probing) return;
  flushSourcePush();
  await inflight;
  const remote = await fetchRemoteSources(origin, AbortSignal.timeout(4_000));
  if (!remote?.updatedAt || probing || pending) return;
  if (remote.updatedAt === (await loadSourcesStamp())) return;
  await saveSources(remote.sources);
  await saveSourcesStamp(remote.updatedAt);
  announce(remote.sources, "refresh");
}

/** Flush a pending edit when the page is hidden or closed, and re-read Amber's list when it is shown again. */
export function startSourceSync(origin: string): void {
  window.addEventListener("pagehide", () => flushSourcePush(true));
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) flushSourcePush(true);
    else void refreshRemoteSources(origin);
  });
}
