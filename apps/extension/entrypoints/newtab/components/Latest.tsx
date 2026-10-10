import { useEffect, useMemo, useRef, useState } from "react";
import type { ArchiveArticleMeta, FeedItem } from "@homepage/agent-core";
import { groupFeed, relativeTime } from "../format";
import { entryFromFeed, type ReaderEntry } from "../readerEntry";
import { findArchived, LATEST_HOURS, useLatest } from "../useLatest";

const COLLAPSED_SOURCES = 7;

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable;
}

function focusRow(id: string) {
  document.getElementById(`lrow-${id}`)?.focus({ preventScroll: true });
}

function matches(item: FeedItem, tokens: string[]): boolean {
  if (tokens.length === 0) return true;
  const haystack = `${item.title} ${item.author ?? ""} ${item.source}`.toLowerCase();
  return tokens.every((t) => haystack.includes(t));
}

/** Re-renders every `ms` so "12 min ago" stays true while the page is open. */
function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}

export function Latest({
  archiveUrl,
  active,
  reloadToken,
  saved,
  blockedSites,
  cursorId,
  onCursor,
  onOpen,
  onOpenSettings,
}: {
  archiveUrl: string | null;
  /** This view is showing and neither the reader nor settings covers it. */
  active: boolean;
  reloadToken: number;
  /** Stories saved from the Reader this session, by link key, so they say "In Amber" at once. */
  saved: Map<string, ArchiveArticleMeta>;
  /** Stories whose link is on one of these sites are not shown. */
  blockedSites: string[];
  cursorId: string | null;
  onCursor: (id: string | null) => void;
  /** Open the reader on `entry`; `list` is the order prev/next should walk. */
  onOpen: (entry: ReaderEntry, list: ReaderEntry[]) => void;
  onOpenSettings: () => void;
}) {
  const { state, items, statuses, archived, enabledCount, refresh, retrySource } = useLatest({
    archiveUrl,
    active,
    reloadToken,
    blockedSites,
  });
  const now = useNow(30_000);
  const [query, setQuery] = useState("");
  const [source, setSource] = useState<string | null>(null);
  const [allSources, setAllSources] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  const tokens = useMemo(() => query.toLowerCase().split(/\s+/).filter(Boolean), [query]);

  const searched = useMemo(() => items.filter((i) => matches(i, tokens)), [items, tokens]);
  const visible = useMemo(
    () => (source ? searched.filter((i) => i.source === source) : searched),
    [searched, source],
  );
  const groups = useMemo(() => groupFeed(visible, now), [visible, now]);

  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const i of searched) map.set(i.source, (map.get(i.source) ?? 0) + 1);
    return map;
  }, [searched]);

  // Chips follow the catalog's order (most-read first), so they hold still while you search.
  const chips = useMemo(() => {
    const all = state.catalog.filter((s) => s.enabled).map((s) => s.name);
    if (allSources) return all;
    const head = all.slice(0, COLLAPSED_SOURCES);
    if (source && !head.includes(source) && all.includes(source)) head.push(source);
    return head;
  }, [state.catalog, allSources, source]);
  const totalChips = enabledCount;
  const hiddenSources = totalChips - chips.length;

  const archivedFor = (item: FeedItem) => findArchived(archived, saved, item.link);

  // The reader's list: every visible story, with the archive's copy where there is one.
  const entries = useMemo(
    () => visible.map((item) => entryFromFeed(item, findArchived(archived, saved, item.link))),
    [visible, archived, saved],
  );
  const entryById = useMemo(() => new Map(visible.map((item, i) => [item.id, entries[i]])), [visible, entries]);

  useEffect(() => {
    if (cursorId && !visible.some((i) => i.id === cursorId)) onCursor(null);
  }, [visible, cursorId, onCursor]);

  useEffect(() => {
    if (!cursorId) return;
    document.getElementById(`lrow-${cursorId}`)?.scrollIntoView({ block: "nearest" });
  }, [cursorId]);

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "/" && !isTyping(e.target)) {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
        return;
      }
      if (isTyping(e.target)) return;
      if (e.key === "j" || e.key === "k") {
        if (visible.length === 0) return;
        e.preventDefault();
        const at = visible.findIndex((i) => i.id === cursorId);
        const next = e.key === "j" ? Math.min(visible.length - 1, at + 1) : Math.max(0, at < 0 ? 0 : at - 1);
        onCursor(visible[next].id);
        focusRow(visible[next].id);
      } else if (e.key === "Enter" && cursorId) {
        const t = e.target as HTMLElement;
        const onRow = !!t.closest?.(".row");
        const idle = t === document.body || t.tagName === "MAIN" || t.classList?.contains("lib");
        if (!onRow && !idle) return;
        const entry = entryById.get(cursorId);
        if (!entry) return;
        e.preventDefault();
        onOpen(entry, entries);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, visible, cursorId, onCursor, onOpen, entries, entryById]);

  const clearFilters = () => {
    setQuery("");
    setSource(null);
  };

  const loading = state.phase === "loading";
  const offline = typeof navigator !== "undefined" && navigator.onLine === false;
  const settled = state.pending.length === 0;
  const everyFailed =
    !loading && settled && enabledCount > 0 && statuses.length > 0 && statuses.every((s) => s.error && s.count === 0);
  const problems = statuses.filter((s) => s.error && !state.pending.includes(s.name));
  const hasStream = items.length > 0;
  const noSources = !loading && enabledCount === 0;

  const updated = state.refreshing
    ? "Updating…"
    : state.updatedAt
      ? `Updated ${relativeTime(new Date(state.updatedAt).toISOString(), now)}`
      : "";

  return (
    <div className="lib latest">
      <header className="lib-head">
        <h1 className="lib-title">Latest</h1>
        <span className="latest-tools">
          {updated && (
            <span className="meta" aria-live="polite">
              {updated}
            </span>
          )}
          <button
            type="button"
            className={`icon-btn latest-refresh${state.refreshing ? " spinning" : ""}`}
            onClick={() => void refresh({ force: true })}
            disabled={state.refreshing || noSources}
            title="Refresh"
            aria-label="Refresh"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M20 12a8 8 0 1 1-2.6-5.9" />
              <path d="M20 4v4.5h-4.5" />
            </svg>
          </button>
        </span>
      </header>

      {(hasStream || loading) && (
        <div className="search">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
            <circle cx="11" cy="11" r="6.5" />
            <path d="m20 20-4-4" />
          </svg>
          <input
            ref={searchRef}
            type="search"
            value={query}
            placeholder="Search headlines, authors, sources"
            aria-label="Search the latest stories"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                if (query) setQuery("");
                else e.currentTarget.blur();
              } else if (e.key === "Enter" || e.key === "ArrowDown") {
                e.preventDefault();
                e.currentTarget.blur();
                if (visible.length) {
                  onCursor(visible[0].id);
                  focusRow(visible[0].id);
                }
              }
            }}
          />
          <kbd>/</kbd>
        </div>
      )}

      {!loading && chips.length > 0 && (
        <div className="chips" role="group" aria-label="Filter by source">
          <button
            type="button"
            className={`chip${source === null ? " on" : ""}`}
            aria-pressed={source === null}
            onClick={() => setSource(null)}
          >
            All <span className="chip-n">{searched.length}</span>
          </button>
          {chips.map((name) => {
            const n = counts.get(name) ?? 0;
            const waiting = state.pending.includes(name) && n === 0;
            return (
              <button
                key={name}
                type="button"
                className={`chip${source === name ? " on" : ""}${n === 0 ? " empty" : ""}`}
                aria-pressed={source === name}
                onClick={() => setSource(source === name ? null : name)}
              >
                {name} <span className="chip-n">{waiting ? "…" : n}</span>
              </button>
            );
          })}
          {(hiddenSources > 0 || allSources) && totalChips > COLLAPSED_SOURCES && (
            <button
              type="button"
              className="chip more"
              aria-expanded={allSources}
              onClick={() => setAllSources((v) => !v)}
            >
              {allSources ? "Fewer" : `${hiddenSources} more`}
            </button>
          )}
        </div>
      )}

      {!loading && problems.length > 0 && !everyFailed && (
        <ul className="latest-problems" aria-label="Sources that did not load">
          {problems.map((p) => (
            <li key={p.name} className="latest-problem" title={p.error}>
              <span className="latest-problem-dot" aria-hidden="true" />
              <span className="latest-problem-text">
                <b>{p.name}</b> {p.count === 0 ? "couldn’t load" : "didn’t fully load"}
              </span>
              <button type="button" className="ghost-btn small" onClick={() => void retrySource(p.name)}>
                Retry
              </button>
            </li>
          ))}
        </ul>
      )}

      {loading && <Skeleton />}

      {noSources && (
        <Notice
          title="No sources yet."
          body={
            state.sourcesError
              ? "Couldn’t read your sources list. Add some in Settings, under Sources."
              : state.catalog.length > 0
                ? "Every source is switched off. Turn some on in Settings, under Sources, and their newest stories appear here."
                : "Add the sites you read in Settings, under Sources, and their newest stories appear here."
          }
          action={{ label: "Open settings", onClick: onOpenSettings }}
        />
      )}

      {!loading && enabledCount > 0 && !hasStream && everyFailed && (
        <Notice
          title={offline ? "You’re offline." : "Couldn’t reach your sources."}
          body={
            offline
              ? "Latest needs a connection. Your saved articles are still in the Library."
              : "None of your sources answered. Check your connection, then try again."
          }
          action={{ label: "Retry", onClick: () => void refresh({ force: true }) }}
        />
      )}

      {!loading && settled && enabledCount > 0 && !hasStream && !everyFailed && (
        <Notice
          title={`Nothing new in the last ${Math.round(LATEST_HOURS / 24)} days.`}
          body="Your sources haven’t published anything in that time."
          action={{ label: "Check again", onClick: () => void refresh({ force: true }) }}
        />
      )}

      {hasStream && everyFailed && (
        <p className="latest-stale" role="status">
          {offline ? "You’re offline" : "Couldn’t reach your sources"}. Showing what was loaded earlier.
        </p>
      )}

      {hasStream && visible.length === 0 && (
        <Notice
          title="No stories match."
          body="Try a different word, or clear the filters."
          action={{ label: "Clear filters", onClick: clearFilters }}
        />
      )}

      {visible.length > 0 && (
        <>
          <div className="groups">
            {groups.map((group) => (
              <section key={group.key} className="day-group">
                <h2 className="day">
                  <span>{group.label}</span>
                  <span className="day-n">{group.items.length}</span>
                </h2>
                <ul className="rows">
                  {group.items.map((item) => (
                    <Row
                      key={item.id}
                      item={item}
                      now={now}
                      inAmber={archivedFor(item) !== undefined}
                      cursor={item.id === cursorId}
                      onOpen={() => {
                        const entry = entryById.get(item.id);
                        if (!entry) return;
                        onCursor(item.id);
                        onOpen(entry, entries);
                      }}
                    />
                  ))}
                </ul>
              </section>
            ))}
          </div>

          <footer className="lib-foot">
            <p className="keys">
              <kbd>j</kbd> <kbd>k</kbd> move · <kbd>Enter</kbd> read · <kbd>/</kbd> search
            </p>
          </footer>
        </>
      )}
    </div>
  );
}

function Row({
  item,
  now,
  inAmber,
  cursor,
  onOpen,
}: {
  item: FeedItem;
  now: number;
  inAmber: boolean;
  cursor: boolean;
  onOpen: () => void;
}) {
  const when = relativeTime(item.publishedAt, now);
  return (
    <li>
      <button id={`lrow-${item.id}`} type="button" className={`row${cursor ? " cursor" : ""}`} onClick={onOpen}>
        <span className="row-main">
          <span className="row-title">{item.title}</span>
          {item.summary && <span className="latest-blurb">{item.summary}</span>}
          <span className="row-meta">
            <span className="row-site">{item.source}</span>
            {item.author && <span>{item.author}</span>}
            {inAmber && (
              <span className="row-amber">
                <span className="row-amber-dot" aria-hidden="true" />
                In Amber
              </span>
            )}
          </span>
        </span>
        <span className="row-time" title={item.publishedAt ? new Date(item.publishedAt).toLocaleString() : undefined}>
          {when}
        </span>
      </button>
    </li>
  );
}

function Skeleton() {
  return (
    <div className="skeleton" aria-hidden="true">
      {[62, 80, 54, 72, 66, 78, 58].map((w, i) => (
        <div key={i} className="sk-row">
          <div className="sk-bar" style={{ width: `${w}%` }} />
          <div className="sk-bar sk-small" style={{ width: `${Math.max(24, w - 38)}%` }} />
        </div>
      ))}
    </div>
  );
}

function Notice({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action: { label: string; onClick: () => void };
}) {
  return (
    <div className="notice" role="status">
      <p className="notice-title">{title}</p>
      <p className="notice-body">{body}</p>
      <button type="button" className="ghost-btn" onClick={action.onClick}>
        {action.label}
      </button>
    </div>
  );
}
