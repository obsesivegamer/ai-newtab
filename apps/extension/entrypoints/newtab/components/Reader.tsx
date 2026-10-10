import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ArchiveArticle, ArchiveArticleMeta } from "@homepage/agent-core";
import { createArchiveBridge } from "@/lib/archive";
import { toReadable, wordCount } from "../articleText";
import { formatDate, readingMinutes } from "../format";
import { useTextSize, type Theme } from "../uiPrefs";
import { ThemeToggle } from "./ThemeToggle";

type Load =
  | { status: "loading" }
  | { status: "ready"; article: ArchiveArticle }
  | { status: "error"; message: string };

const UNREACHABLE = "Couldn't reach Amber. Is it running? Start it with ./run.sh";

type FetchResult = { article: ArchiveArticle } | { error: string };

interface InFlight {
  promise: Promise<FetchResult>;
  controller: AbortController;
  watchers: number;
}

function failureMessage(reason: string): string {
  if (/responded 404/.test(reason)) return "Amber has no readable text for this article.";
  if (/responded \d+/.test(reason)) return "Amber answered with an error.";
  return UNREACHABLE;
}

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
}

export function Reader({
  id,
  list,
  archiveUrl,
  theme,
  onToggleTheme,
  onNavigate,
  onClose,
  keysActive,
}: {
  id: string;
  /** The Library's current order. Empty when opened from the model-built homepage. */
  list: ArchiveArticleMeta[];
  archiveUrl: string | null;
  theme: Theme;
  onToggleTheme: () => void;
  onNavigate: (id: string) => void;
  onClose: () => void;
  keysActive: boolean;
}) {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const progressRef = useRef<HTMLDivElement>(null);
  const { size, canShrink, canGrow, shrink, grow } = useTextSize();

  const position = list.findIndex((a) => a.id === id);
  const previous = position > 0 ? list[position - 1] : null;
  const next = position >= 0 && position < list.length - 1 ? list[position + 1] : null;
  const meta = position >= 0 ? list[position] : null;

  // One request per article id, shared by the main load and the prefetch. It is aborted
  // once nothing is watching it any more (the reader moved on), and cached on success.
  const cache = useRef(new Map<string, ArchiveArticle>());
  const inflight = useRef(new Map<string, InFlight>());

  const watch = useCallback(
    (articleId: string, url: string) => {
      let entry = inflight.current.get(articleId);
      if (!entry) {
        const controller = new AbortController();
        const created: InFlight = {
          controller,
          watchers: 0,
          promise: createArchiveBridge(url)
            .getArticles({ ids: [articleId], signal: controller.signal })
            .then(({ articles, failed }): FetchResult => {
              const article = articles[0];
              if (article) {
                cache.current.set(articleId, article);
                return { article };
              }
              return { error: failureMessage(failed[0]?.reason ?? "") };
            })
            .catch((): FetchResult => ({ error: UNREACHABLE }))
            .finally(() => {
              if (inflight.current.get(articleId) === created) inflight.current.delete(articleId);
            }),
        };
        inflight.current.set(articleId, created);
        entry = created;
      }
      const shared = entry;
      shared.watchers++;
      let released = false;
      return {
        promise: shared.promise,
        release() {
          if (released) return;
          released = true;
          shared.watchers--;
          // Deferred a microtask so an effect that re-watches in the same commit keeps it alive.
          queueMicrotask(() => {
            if (shared.watchers <= 0) {
              shared.controller.abort();
              if (inflight.current.get(articleId) === shared) inflight.current.delete(articleId);
            }
          });
        },
      };
    },
    [],
  );

  useEffect(() => {
    if (archiveUrl === null) return;
    if (archiveUrl.trim() === "") {
      setLoad({ status: "error", message: "The archive is turned off in Settings." });
      return;
    }
    const cached = cache.current.get(id);
    if (cached) {
      setLoad({ status: "ready", article: cached });
      return;
    }
    let cancelled = false;
    setLoad({ status: "loading" });
    const watcher = watch(id, archiveUrl);
    void watcher.promise.then((result) => {
      if (cancelled) return;
      setLoad("article" in result ? { status: "ready", article: result.article } : { status: "error", message: result.error });
    });
    return () => {
      cancelled = true;
      watcher.release();
    };
  }, [id, archiveUrl, attempt, watch]);

  // Each article starts at the top, and the pane takes keyboard focus so space and arrows scroll it.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
    progressRef.current?.style.setProperty("transform", "scaleX(0)");
    scrollRef.current?.focus({ preventScroll: true });
  }, [id]);

  // Quietly warm the next article so j feels instant.
  useEffect(() => {
    if (!next || !archiveUrl || cache.current.has(next.id) || load.status !== "ready") return;
    const watcher = watch(next.id, archiveUrl);
    return () => watcher.release();
  }, [next, archiveUrl, load.status, watch]);

  useEffect(() => {
    if (!keysActive) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if ((e.key === "j" || e.key === "ArrowRight") && next) {
        e.preventDefault();
        onNavigate(next.id);
      } else if ((e.key === "k" || e.key === "ArrowLeft") && previous) {
        e.preventDefault();
        onNavigate(previous.id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [keysActive, next, previous, onClose, onNavigate]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    const bar = progressRef.current;
    if (!el || !bar) return;
    const max = el.scrollHeight - el.clientHeight;
    bar.style.setProperty("transform", `scaleX(${max > 0 ? Math.min(1, el.scrollTop / max) : 0})`);
  }, []);

  const article = load.status === "ready" ? load.article : null;
  const title = article?.title ?? meta?.title ?? "";
  const site = article?.site ?? meta?.site ?? "";
  const author = article?.author ?? meta?.author;
  const published = formatDate(article?.publishedAt ?? meta?.publishedAt);
  const saved = formatDate(article?.savedAt ?? meta?.savedAt);

  const readable = useMemo(() => (article ? toReadable(article.text, article.title, article.author) : null), [article]);
  const words = article ? wordCount(article.text) : (meta?.wordCount ?? 0);
  const paywalled = article?.paywalled ?? meta?.paywalled ?? false;

  const originalUrl = article?.originalUrl ?? meta?.originalUrl;
  const permalink = article?.permalink ?? meta?.permalink;

  return (
    <div className="reader" role="dialog" aria-modal="true" aria-label={title || "Article"}>
      <div className="reader-progress" ref={progressRef} />
      <div className="reader-bar">
        <button type="button" className="back-btn" onClick={onClose} title="Back to the library (Esc)">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M15 5l-7 7 7 7" />
          </svg>
          Library
        </button>
        <span className="bar-spacer" />
        {position >= 0 && (
          <span className="meta bar-pos">
            {position + 1} of {list.length}
          </span>
        )}
        {position >= 0 && (
          <>
            <button type="button" className="icon-btn" disabled={!previous} onClick={() => previous && onNavigate(previous.id)} title="Previous article (k)" aria-label="Previous article">
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="m6 15 6-6 6 6" />
              </svg>
            </button>
            <button type="button" className="icon-btn" disabled={!next} onClick={() => next && onNavigate(next.id)} title="Next article (j)" aria-label="Next article">
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="m6 9 6 6 6-6" />
              </svg>
            </button>
            <span className="bar-rule" />
          </>
        )}
        <button type="button" className="icon-btn text-btn" disabled={!canShrink} onClick={shrink} title="Smaller text" aria-label="Smaller text">
          <span style={{ fontSize: 13 }}>A</span>
        </button>
        <button type="button" className="icon-btn text-btn" disabled={!canGrow} onClick={grow} title="Larger text" aria-label="Larger text">
          <span style={{ fontSize: 19 }}>A</span>
        </button>
        <ThemeToggle theme={theme} onToggle={onToggleTheme} />
      </div>

      <div
        className="reader-scroll"
        ref={scrollRef}
        onScroll={onScroll}
        tabIndex={-1}
        style={{ ["--reader-size" as string]: `${size}px` }}
      >
        <article className="reader-article" key={id}>
          {(title || load.status === "loading") && (
            <header className="reader-head">
              {site && <p className="reader-site">{site}</p>}
              {title ? <h1 className="reader-title">{title}</h1> : <div className="sk-bar sk-title" />}
              {readable?.deck && <p className="reader-deck">{readable.deck}</p>}
              <p className="reader-meta">
                {author && <span className="by">{author}</span>}
                {published && <span>{published}</span>}
                {words > 0 && <span>{readingMinutes(words)} min read</span>}
                {saved && <span>Saved {saved}</span>}
              </p>
              {(originalUrl || permalink) && (
                <p className="reader-links">
                  {originalUrl && (
                    <a href={originalUrl} target="_blank" rel="noopener noreferrer">
                      Open original
                    </a>
                  )}
                  {permalink && (
                    <a href={permalink} target="_blank" rel="noopener noreferrer">
                      Open in Amber
                    </a>
                  )}
                </p>
              )}
            </header>
          )}

          {load.status === "loading" && (
            <div className="reader-skeleton" aria-hidden="true">
              {Array.from({ length: 9 }, (_, i) => (
                <div key={i} className="sk-bar" style={{ width: i % 4 === 3 ? "58%" : "100%" }} />
              ))}
            </div>
          )}

          {load.status === "error" && (
            <div className="notice reader-notice" role="alert">
              <p className="notice-title">This article didn&apos;t load.</p>
              <p className="notice-body">{load.message}</p>
              <div className="notice-actions">
                <button type="button" className="ghost-btn" onClick={() => setAttempt((n) => n + 1)}>
                  Retry
                </button>
                {originalUrl && (
                  <a className="ghost-btn" href={originalUrl} target="_blank" rel="noopener noreferrer">
                    Open original
                  </a>
                )}
              </div>
            </div>
          )}

          {readable && (
            <div className="reader-body">
              {(paywalled || readable.paywallPage) && (
                <p className="reader-note">
                  {readable.paywallPage
                    ? "This capture is the publisher's subscription page, not the article."
                    : "This capture hit a paywall, so the text may be partial."}
                </p>
              )}
              {readable.paragraphs.map((p, i) => (
                <p key={i}>{p}</p>
              ))}
            </div>
          )}

          {readable && (
            <footer className="reader-foot">
              {next ? (
                <button type="button" className="next-card" onClick={() => onNavigate(next.id)}>
                  <span className="meta">Next · {next.site}</span>
                  <span className="next-title">{next.title}</span>
                </button>
              ) : (
                <p className="meta">End of the list</p>
              )}
            </footer>
          )}
        </article>
      </div>
    </div>
  );
}
