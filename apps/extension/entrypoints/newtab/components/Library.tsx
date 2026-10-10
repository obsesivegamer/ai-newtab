import { useEffect, useMemo, useRef, useState } from "react";
import type { ArchiveArticleMeta } from "@homepage/agent-core";
import { groupByDay, readingMinutes, SHORT_WORDS } from "../format";
import { LIBRARY_DAYS, LIBRARY_LIMIT, type ArchiveListState } from "../useArchiveList";

const COLLAPSED_SOURCES = 7;

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable;
}

function matches(article: ArchiveArticleMeta, tokens: string[]): boolean {
  if (tokens.length === 0) return true;
  const haystack = `${article.title} ${article.author ?? ""} ${article.site}`.toLowerCase();
  return tokens.every((t) => haystack.includes(t));
}

export function Library({
  state,
  archiveUrl,
  onReload,
  onOpen,
  cursorId,
  onCursor,
  keysActive,
  onOpenSettings,
}: {
  state: ArchiveListState;
  archiveUrl: string | null;
  onReload: () => void;
  /** Open the reader on `id`; `list` is the order prev/next should walk. */
  onOpen: (id: string, list: ArchiveArticleMeta[]) => void;
  cursorId: string | null;
  onCursor: (id: string | null) => void;
  /** False while the reader or the settings modal has the keyboard. */
  keysActive: boolean;
  onOpenSettings: () => void;
}) {
  const [query, setQuery] = useState("");
  const [source, setSource] = useState<string | null>(null);
  const [allSources, setAllSources] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  const ready = state.status === "ready" ? state : null;

  const tokens = useMemo(
    () => query.toLowerCase().split(/\s+/).filter(Boolean),
    [query],
  );

  const searched = useMemo(
    () => (ready ? ready.articles.filter((a) => matches(a, tokens)) : []),
    [ready, tokens],
  );
  const visible = useMemo(
    () => (source ? searched.filter((a) => a.site === source) : searched),
    [searched, source],
  );
  const groups = useMemo(() => groupByDay(visible), [visible]);

  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const a of searched) map.set(a.site, (map.get(a.site) ?? 0) + 1);
    return map;
  }, [searched]);

  // Sources keep the archive's own order (most saved first), not the search's.
  const chips = useMemo(() => {
    if (!ready) return [];
    const all = ready.sources.map((s) => s.site);
    if (allSources) return all;
    const head = all.slice(0, COLLAPSED_SOURCES);
    if (source && !head.includes(source)) head.push(source);
    return head;
  }, [ready, allSources, source]);
  const hiddenSources = ready ? ready.sources.length - chips.length : 0;

  // Keep the cursor inside what's on screen.
  useEffect(() => {
    if (cursorId && !visible.some((a) => a.id === cursorId)) onCursor(null);
  }, [visible, cursorId, onCursor]);

  // Bring the cursor row into view (after j/k, or after closing the reader).
  useEffect(() => {
    if (!cursorId) return;
    document.getElementById(`row-${cursorId}`)?.scrollIntoView({ block: "nearest" });
  }, [cursorId]);

  useEffect(() => {
    if (!keysActive) return;
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
        const at = visible.findIndex((a) => a.id === cursorId);
        const next = e.key === "j" ? Math.min(visible.length - 1, at + 1) : Math.max(0, at < 0 ? 0 : at - 1);
        onCursor(visible[next].id);
      } else if (e.key === "Enter" && cursorId) {
        const t = e.target as HTMLElement;
        if (t.tagName === "BUTTON" || t.tagName === "A") return;
        e.preventDefault();
        onOpen(cursorId, visible);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [keysActive, visible, cursorId, onCursor, onOpen]);

  const clearFilters = () => {
    setQuery("");
    setSource(null);
  };

  return (
    <div className="lib">
      <header className="lib-head">
        <h1 className="lib-title">Library</h1>
        {ready && (
          <span className="meta">
            {ready.totalUsable} saved · last {LIBRARY_DAYS} days
          </span>
        )}
      </header>

      {(ready || state.status === "loading") && (
      <div className="search">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
          <circle cx="11" cy="11" r="6.5" />
          <path d="m20 20-4-4" />
        </svg>
        <input
          ref={searchRef}
          type="search"
          value={query}
          placeholder="Search titles, authors, sources"
          aria-label="Search the library"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              if (query) setQuery("");
              else e.currentTarget.blur();
            } else if (e.key === "Enter" || e.key === "ArrowDown") {
              e.preventDefault();
              e.currentTarget.blur();
              if (visible.length) onCursor(visible[0].id);
            }
          }}
        />
        <kbd>/</kbd>
      </div>
      )}

      {ready && ready.sources.length > 0 && (
        <div className="chips" role="group" aria-label="Filter by source">
          <button
            type="button"
            className={`chip${source === null ? " on" : ""}`}
            aria-pressed={source === null}
            onClick={() => setSource(null)}
          >
            All <span className="chip-n">{searched.length}</span>
          </button>
          {chips.map((site) => {
            const n = counts.get(site) ?? 0;
            return (
              <button
                key={site}
                type="button"
                className={`chip${source === site ? " on" : ""}${n === 0 ? " empty" : ""}`}
                aria-pressed={source === site}
                onClick={() => setSource(source === site ? null : site)}
              >
                {site} <span className="chip-n">{n}</span>
              </button>
            );
          })}
          {(hiddenSources > 0 || allSources) && ready.sources.length > COLLAPSED_SOURCES && (
            <button type="button" className="chip more" onClick={() => setAllSources((v) => !v)}>
              {allSources ? "Fewer" : `${hiddenSources} more`}
            </button>
          )}
        </div>
      )}

      {state.status === "loading" && <Skeleton />}

      {state.status === "off" && (
        <Notice
          title="The archive is turned off."
          body="Add your Amber address in Settings to read your saved articles here."
          action={{ label: "Open settings", onClick: onOpenSettings }}
        />
      )}

      {state.status === "error" && state.kind === "down" && (
        <Notice
          title="Amber isn't running."
          body="Start it with ./run.sh, then try again."
          hint={archiveUrl ? `Looking for it at ${archiveUrl}` : undefined}
          action={{ label: "Retry", onClick: onReload }}
        />
      )}
      {state.status === "error" && state.kind === "no-api" && (
        <Notice
          title="Amber is running, but it has no article API."
          body="This version of Amber predates the JSON API the library reads. Update it and restart."
          hint={archiveUrl ?? undefined}
          action={{ label: "Retry", onClick: onReload }}
        />
      )}
      {state.status === "error" && state.kind === "other" && (
        <Notice
          title="Amber didn't answer properly."
          body={state.detail}
          action={{ label: "Retry", onClick: onReload }}
        />
      )}

      {ready && ready.articles.length === 0 && (
        <Notice
          title={`Nothing saved in the last ${LIBRARY_DAYS} days.`}
          body="Save an article in Amber and it will appear here."
          action={{ label: "Check again", onClick: onReload }}
        />
      )}

      {ready && ready.articles.length > 0 && visible.length === 0 && (
        <Notice
          title="No articles match."
          body="Try a different word, or clear the filters."
          action={{ label: "Clear filters", onClick: clearFilters }}
        />
      )}

      {ready && visible.length > 0 && (
        <>
          <div className="groups">
            {groups.map((group) => (
              <section key={group.key} className="day-group">
                <h2 className="day">
                  <span>{group.label}</span>
                  <span className="day-n">{group.items.length}</span>
                </h2>
                <ul className="rows">
                  {group.items.map((article) => (
                    <Row
                      key={article.id}
                      article={article}
                      cursor={article.id === cursorId}
                      onOpen={() => {
                        onCursor(article.id);
                        onOpen(article.id, visible);
                      }}
                    />
                  ))}
                </ul>
              </section>
            ))}
          </div>

          <footer className="lib-foot">
            {ready.totalUsable > ready.articles.length && (
              <p>
                Showing the newest {LIBRARY_LIMIT} of {ready.totalUsable}.
              </p>
            )}
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
  article,
  cursor,
  onOpen,
}: {
  article: ArchiveArticleMeta;
  cursor: boolean;
  onOpen: () => void;
}) {
  const short = article.wordCount > 0 && article.wordCount < SHORT_WORDS;
  return (
    <li>
      <button
        id={`row-${article.id}`}
        type="button"
        className={`row${cursor ? " cursor" : ""}`}
        onClick={onOpen}
      >
        <span className="row-main">
          <span className="row-title">{article.title}</span>
          <span className="row-meta">
            <span className="row-site">{article.site}</span>
            {article.author && <span>{article.author}</span>}
            {article.paywalled && <span className="tag">Paywalled</span>}
            {short && <span className="tag">Short</span>}
          </span>
        </span>
        <span className="row-time">{readingMinutes(article.wordCount)} min</span>
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
  hint,
  action,
}: {
  title: string;
  body: string;
  hint?: string;
  action: { label: string; onClick: () => void };
}) {
  return (
    <div className="notice" role="status">
      <p className="notice-title">{title}</p>
      <p className="notice-body">{body}</p>
      {hint && <p className="meta notice-hint">{hint}</p>}
      <button type="button" className="ghost-btn" onClick={action.onClick}>
        {action.label}
      </button>
    </div>
  );
}
