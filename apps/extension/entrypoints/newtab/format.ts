import type { ArchiveArticleMeta } from "@homepage/agent-core";

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
