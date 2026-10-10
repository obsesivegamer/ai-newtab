import { effectiveTime, type ArchiveArticleMeta } from "@homepage/agent-core";

export const WORDS_PER_MINUTE = 230;
/** Articles under this read as a brief, and are marked as such. */
export const SHORT_WORDS = 350;

export function readingMinutes(words: number): number {
  return Math.max(1, Math.round(words / WORDS_PER_MINUTE));
}

function validDate(iso: string | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

const shortDate = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
const shortDateYear = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });
const longDay = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric" });
const longDayYear = new Intl.DateTimeFormat("en-US", {
  weekday: "long",
  month: "long",
  day: "numeric",
  year: "numeric",
});

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

export function dayKey(iso: string): string {
  const d = validDate(iso);
  if (!d) return "unknown";
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/** "Today", "Yesterday", or "Sunday, September 27" (with the year when it isn't this one). */
export function dayLabel(iso: string, now = new Date()): string {
  const d = validDate(iso);
  if (!d) return "Undated";
  const days = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return (d.getFullYear() === now.getFullYear() ? longDay : longDayYear).format(d);
}

export function formatDate(iso: string | undefined, now = new Date()): string | null {
  const d = validDate(iso);
  if (!d) return null;
  return (d.getFullYear() === now.getFullYear() ? shortDate : shortDateYear).format(d);
}

export function groupByDay(articles: ArchiveArticleMeta[], now = new Date()) {
  const groups: Array<{ key: string; label: string; items: ArchiveArticleMeta[] }> = [];
  for (const article of articles) {
    const key = dayKey(article.savedAt);
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.items.push(article);
    else groups.push({ key, label: dayLabel(article.savedAt, now), items: [article] });
  }
  return groups;
}

const clock = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });

/**
 * A time as it should read right now: "just now", "12 min ago", "3 h ago", then
 * the clock time for anything older (the day group says which day). Computed at
 * display time, never stored.
 */
export function relativeTime(iso: string | undefined, now = Date.now()): string {
  const d = validDate(iso);
  // A date far in the future is a feed bug; say nothing rather than "just now".
  if (!d || effectiveTime(iso, now) === -Infinity) return "";
  const minutes = Math.floor((now - d.getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 12 * 60) return `${Math.floor(minutes / 60)} h ago`;
  return clock.format(d);
}

/**
 * Like `groupByDay`, for a feed stream: the last hour is its own group, then one per
 * day, then the undated. A date more than a few minutes ahead of `now` counts as
 * undated (a feed bug, not news from tomorrow); a slightly-ahead one counts as now.
 * Items of one group end up together whatever their order, so keys are unique.
 */
export function groupFeed<T extends { publishedAt?: string }>(items: T[], now = Date.now()) {
  const groups = new Map<string, { key: string; label: string; items: T[] }>();
  const today = new Date(now);
  for (const item of items) {
    const t = effectiveTime(item.publishedAt, now);
    let key: string;
    let label: string;
    if (t === -Infinity) {
      key = "undated";
      label = "Date unknown";
    } else if (now - t < 60 * 60_000) {
      key = "hour";
      label = "Last hour";
    } else {
      const iso = new Date(t).toISOString();
      key = dayKey(iso);
      label = dayLabel(iso, today);
    }
    const group = groups.get(key);
    if (group) group.items.push(item);
    else groups.set(key, { key, label, items: [item] });
  }
  return [...groups.values()];
}
