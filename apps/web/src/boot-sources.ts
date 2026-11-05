import type { FeedSource } from "@homepage/agent-core";

/**
 * What to do with Amber's sources list when the phone web app loads.
 *
 * `adopt` — Amber's stamp moved (or this device has no saved list). Take Amber's list.
 * `keep` — The stamp still matches and the stored list is the same. Leave it alone.
 * `push` — The stamp still matches, but the stored list differs. That difference is an
 * edit saved on this device and not yet accepted by Amber (a reload during the push
 * pause). Push it. Adopting Amber's copy here would throw the edit away.
 */
export type BootSourcesDecision = "adopt" | "keep" | "push";

export function decideBootSources(
  localStamp: string | null,
  remoteStamp: string | null,
  localSources: FeedSource[] | null,
  remoteSources: FeedSource[],
): BootSourcesDecision {
  if (remoteStamp && localSources && remoteStamp === localStamp) {
    return sameSourceList(localSources, remoteSources) ? "keep" : "push";
  }
  return "adopt";
}

function sameSourceList(a: FeedSource[], b: FeedSource[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const left = a[i];
    const right = b[i];
    if (!left || !right) return false;
    if (left.id !== right.id || left.name !== right.name) return false;
    if ((left.enabled !== false) !== (right.enabled !== false)) return false;
    if (left.feedUrls.length !== right.feedUrls.length) return false;
    for (let j = 0; j < left.feedUrls.length; j++) {
      if (left.feedUrls[j] !== right.feedUrls[j]) return false;
    }
  }
  return true;
}
