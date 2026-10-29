export const HOUR_MS = 60 * 60 * 1000;
/** A refresh asks the Mac to rebuild when the page is at least this old. A fresh page does not. */
export const TODAY_REBUILD_AFTER_MS = HOUR_MS;
/** Always tell the reader when the page they are looking at is older than this. */
export const TODAY_OLD_AFTER_MS = 12 * HOUR_MS;
export const TODAY_POLL_MS = 20_000;
export const TODAY_POLL_LIMIT_MS = 10 * 60 * 1000;

export const ASKED_MAC = "Asked your Mac to rebuild. It runs when Chrome is open on the Mac.";
export const REBUILD_WAIT_TIMED_OUT = "No new page arrived. Your Mac builds when Chrome is open.";
export const REBUILD_EXPIRED = "The last rebuild request expired before a new page arrived.";

const builtFormat = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

/** "just now", "12 min ago", "16h ago", "3d ago". */
export function agePhrase(ms: number): string {
  const elapsed = Number.isFinite(ms) && ms > 0 ? ms : 0;
  const minutes = Math.round(elapsed / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(elapsed / HOUR_MS);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(elapsed / (24 * HOUR_MS))}d ago`;
}

function ageAmount(ms: number): string {
  const phrase = agePhrase(ms);
  return phrase === "just now" ? "less than a minute" : phrase.replace(/ ago$/, "");
}

export function builtClock(timestamp: string): string | null {
  const d = new Date(timestamp);
  return Number.isNaN(d.getTime()) ? null : builtFormat.format(d);
}

export function upToDateLabel(timestamp: string, now: number): string {
  const clock = builtClock(timestamp);
  const at = Date.parse(timestamp);
  const age = Number.isFinite(at) ? agePhrase(now - at) : "some time ago";
  return clock ? `Up to date. Built ${clock} (${age})` : `Up to date. Built on your Mac (${age})`;
}

/** Cooldown copy: the server already fulfilled a request and does not want another yet. */
export function cooldownLabel(timestamp: string, now: number): string {
  const at = Date.parse(timestamp);
  const age = Number.isFinite(at) ? agePhrase(now - at) : "some time ago";
  return `Built ${age}, up to date`;
}

/** A note for a page older than ~12h, including when the reader last copied it. */
export function oldPageNote(timestamp: string, syncedAt: string | undefined, now: number): string | null {
  const built = Date.parse(timestamp);
  if (!Number.isFinite(built) || now - built <= TODAY_OLD_AFTER_MS) return null;
  let note = `This page is ${ageAmount(now - built)} old`;
  if (syncedAt) {
    const synced = Date.parse(syncedAt);
    if (Number.isFinite(synced)) note += `. Synced ${agePhrase(now - synced)}`;
  }
  return note;
}

/** True when the page is under about an hour old, so a refresh should not ask for a rebuild. */
export function isFreshPage(timestamp: string, now: number): boolean {
  const at = Date.parse(timestamp);
  return Number.isFinite(at) && now - at < TODAY_REBUILD_AFTER_MS;
}

/**
 * Refresh asks for a rebuild only when the page is at least ~1h old.
 * A fresh page, including one whose timestamp did not move, does not ask.
 * The server cooldown is what suppresses a second ask after a recent rebuild.
 */
export function shouldAskRebuild(timestamp: string, now: number): boolean {
  const at = Date.parse(timestamp);
  if (!Number.isFinite(at)) return false;
  return now - at >= TODAY_REBUILD_AFTER_MS;
}

/**
 * True only when both timestamps parse and `next` is strictly later.
 * An equal instant, a new `synced_at`, or an unparseable value is not an update.
 */
export function timestampAdvanced(previous: string, next: string): boolean {
  const before = Date.parse(previous);
  const after = Date.parse(next);
  return Number.isFinite(before) && Number.isFinite(after) && after > before;
}
