import type { FeedSource } from "@homepage/agent-core";
import { fetchRemoteSources, pushSources } from "@/lib/phone-sync";
import { saveSources } from "@/lib/sources";

/**
 * Sources are shared with the extension through Amber (`/api/sources`). On load the
 * list Amber holds wins when it has one; without it the page seeds from the archive
 * like the extension does (`loadSources`). Edits are written locally at once and
 * pushed back after a short pause, so tapping a few switches sends one request.
 */

/** Adopt Amber's list as this device's list. Returns whether one was found. */
export async function adoptRemoteSources(origin: string, signal?: AbortSignal): Promise<boolean> {
  const remote = await fetchRemoteSources(origin, signal);
  if (!remote) return false;
  await saveSources(remote);
  return true;
}

const PUSH_DELAY_MS = 800;
let timer: ReturnType<typeof setTimeout> | undefined;
let flush: (() => void) | undefined;

/** Save a person's edit locally, then send it to Amber once edits have paused. */
export function saveAndPushSources(origin: string, sources: FeedSource[]): Promise<void> {
  clearTimeout(timer);
  flush = () => {
    clearTimeout(timer);
    flush = undefined;
    void pushSources(origin, sources);
  };
  timer = setTimeout(() => flush?.(), PUSH_DELAY_MS);
  return saveSources(sources);
}

/** Send a pending edit now (the settings sheet is closing, or the page is being hidden). */
export function flushSourcePush(): void {
  flush?.();
}
