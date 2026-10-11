import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ArchiveArticle, ArchiveArticleMeta } from "@homepage/agent-core";
import { createArchiveBridge } from "@/lib/archive";
import { fetchFullArticle, type FetchFailure, type FetchStage } from "@/lib/archive-save";
import { toReadable, wordCount } from "../articleText";
import { formatDate, readingMinutes } from "../format";
import type { ReaderEntry } from "../readerEntry";
import { useTextSize, type Theme } from "../uiPrefs";
import { ThemeToggle } from "./ThemeToggle";

type Load =
  | { status: "loading" }
  /** An address from the model-built page: nothing is saved until the person asks. */
  | { status: "idle" }
  | { status: "fetching"; stage: FetchStage }
  | { status: "ready"; article: ArchiveArticle }
  | {
      status: "error";
      title: string;
      message: string;
      reason?: FetchFailure;
      /** The attempt that failed was allowed to save, so "Try again" may too (it is a new click). */
      save?: boolean;
    };

const UNREACHABLE = "Couldn't reach Amber. Is it running? Start it (its run script, or its launchd service).";

type FetchResult = { article: ArchiveArticle } | { error: string };

interface InFlight {
  promise: Promise<FetchResult>;
  controller: AbortController;
  watchers: number;
}

const STAGE_TEXT: Record<FetchStage, string> = {
  checking: "Checking your archive…",
  saving: "Saving to your archive…",
  queued: "Waiting in Amber’s queue…",
  capturing: "Capturing the page…",
  reading: "Reading the capture…",
};

/** What to tell the person when the full article could not be had. Calm, and always with a way out. */
function fetchProblem(reason: FetchFailure, detail?: string): { title: string; message: string } {
  switch (reason) {
    case "amber-down":
      return {
        title: "Amber isn’t running.",
        message: "Start Amber to fetch the full article. The headline and summary are all there is until then.",
      };
    case "no-api":
      return {
        title: "This Amber can’t save articles yet.",
        message: "It has no save API. Update Amber and restart it, or read the original.",
      };
    case "busy":
      return { title: "Amber is busy.", message: "It has a lot of saves queued. Give it a moment, then try again." };
    case "invalid-url":
      return {
        title: "That link can’t be saved.",
        message: detail ?? "Amber only saves public web addresses.",
      };
    case "capture-failed":
      return {
        title: "Amber couldn’t capture this page.",
        message: detail
          ? `${detail} The site may have blocked the capture; the original may still open for you.`
          : "The site may have blocked the capture; the original may still open for you.",
      };
    case "paywall-stub":
      return {
        title: "No article text came back.",
        message: "Amber has the page, but the publisher showed a subscription prompt instead of the story.",
      };
    case "timeout":
      return {
        title: "This is taking a while.",
        message: "Amber is still working on it, or gave up quietly. Try again in a moment.",
      };
    default:
      return { title: "This article didn’t load.", message: "Something went wrong reaching Amber." };
  }
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

/** Seconds since `running` became true; 0 while it is not. */
function useElapsed(running: boolean): number {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!running) {
      setSeconds(0);
      return;
    }
    const started = Date.now();
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [running]);
  return seconds;
}

export function Reader({
  entry,
  list,
  archiveUrl,
  theme,
  backLabel,
  onToggleTheme,
  onNavigate,
  onClose,
  onSaved,
  keysActive,
}: {
  entry: ReaderEntry;
  /** The list prev/next walks. Empty when opened from the model-built homepage. */
  list: ReaderEntry[];
  archiveUrl: string | null;
  theme: Theme;
  /** Names the list the reader came from: "Latest", "Library", "Today". */
  backLabel: string;
  onToggleTheme: () => void;
  onNavigate: (entry: ReaderEntry) => void;
  onClose: () => void;
  /** A story from outside the archive is now readable from it. `created` is true when this call saved it. */
  onSaved: (entry: ReaderEntry, meta: ArchiveArticleMeta, created: boolean) => void;
  keysActive: boolean;
}) {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  /**
   * What the person asked for with a click ("Fetch full article", "Try again", "Try capturing
   * again"): it belongs to one article and one attempt. It is dropped when that attempt ends
   * and whenever another article is shown, so walking away and back never saves anything.
   */
  const attemptRef = useRef<{ key: string; force: boolean; save: boolean } | null>(null);
  /** Bumped by each click to start the attempt. */
  const [runN, setRunN] = useState(0);
  const startAttempt = (attempt: { force: boolean; save: boolean }) => {
    attemptRef.current = { key: entry.key, ...attempt };
    setRunN((n) => n + 1);
  };
  const scrollRef = useRef<HTMLDivElement>(null);
  const progressRef = useRef<HTMLDivElement>(null);
  const { size, canShrink, canGrow, shrink, grow } = useTextSize();
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;

  const position = list.findIndex((e) => e.key === entry.key);
  const previous = position > 0 ? list[position - 1] : null;
  const next = position >= 0 && position < list.length - 1 ? list[position + 1] : null;

  // One request per archive id, shared by the main load and the prefetch. It is aborted
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
    if (attemptRef.current && attemptRef.current.key !== entry.key) attemptRef.current = null;
    if (archiveUrl === null) return;
    if (archiveUrl.trim() === "") {
      setLoad({
        status: "error",
        title: "The archive is turned off.",
        message: entry.archiveId
          ? "The archive is turned off in Settings."
          : "Add your Amber address in Settings to fetch full articles here.",
      });
      return;
    }
    const cached = cache.current.get(entry.archiveId ?? entry.key);
    if (cached) {
      setLoad({ status: "ready", article: cached });
      return;
    }

    // Already in Amber: read it.
    if (entry.archiveId) {
      let cancelled = false;
      setLoad({ status: "loading" });
      const watcher = watch(entry.archiveId, archiveUrl);
      void watcher.promise.then((result) => {
        if (cancelled) return;
        setLoad(
          "article" in result
            ? { status: "ready", article: result.article }
            : { status: "error", title: "This article didn’t load.", message: result.error },
        );
      });
      return () => {
        cancelled = true;
        watcher.release();
      };
    }

    // From outside the archive: look it up, and save it only when the person has asked.
    if (!entry.url) {
      setLoad({ status: "error", title: "This article didn’t load.", message: "There is no address to fetch." });
      return;
    }
    const controller = new AbortController();
    const attempt = attemptRef.current;
    const mayFetch = entry.autoFetch === true || attempt?.save === true;
    const force = attempt?.force === true;
    setLoad(mayFetch ? { status: "fetching", stage: "checking" } : { status: "loading" });
    void fetchFullArticle(
      archiveUrl,
      { url: entry.url, force, saveIfMissing: mayFetch },
      {
        signal: controller.signal,
        // A look-up alone shows nothing until it finds something: a capture already under way,
        // or text to read. Only an attempt that may save announces itself from the start.
        onStatus: (stage) => {
          if (mayFetch || stage !== "checking") setLoad({ status: "fetching", stage });
        },
      },
    ).then((result) => {
      if (controller.signal.aborted) return;
      attemptRef.current = null;
      if (result.ok) {
        const article: ArchiveArticle = { ...result.meta, text: result.text };
        cache.current.set(entry.key, article);
        setLoad({ status: "ready", article });
        onSavedRef.current(entry, result.meta, result.created);
      } else if (result.reason === "not-saved") {
        setLoad({ status: "idle" });
      } else if (result.reason !== "aborted") {
        setLoad({
          status: "error",
          ...fetchProblem(result.reason, result.detail),
          reason: result.reason,
          save: mayFetch,
        });
      }
    });
    return () => controller.abort();
    // `entry` is a new object whenever the list rebuilds; its key and address are what identify the work.
    // `entry.autoFetch` is read once per attempt: it belongs to the entry the person clicked.
  }, [entry.key, entry.archiveId, entry.url, archiveUrl, runN, watch]);

  // Each article starts at the top, and the pane takes keyboard focus so space and arrows scroll it.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
    progressRef.current?.style.setProperty("transform", "scaleX(0)");
    scrollRef.current?.focus({ preventScroll: true });
  }, [entry.key]);

  // Quietly warm the next article so j feels instant. Only what is already saved: nothing is captured unasked.
  const nextArchiveId = next?.archiveId;
  useEffect(() => {
    if (!nextArchiveId || !archiveUrl || cache.current.has(nextArchiveId) || load.status !== "ready") return;
    const watcher = watch(nextArchiveId, archiveUrl);
    return () => watcher.release();
  }, [nextArchiveId, archiveUrl, load.status, watch]);

  useEffect(() => {
    if (!keysActive) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if ((e.key === "j" || e.key === "ArrowRight") && next) {
        e.preventDefault();
        onNavigate(next);
      } else if ((e.key === "k" || e.key === "ArrowLeft") && previous) {
        e.preventDefault();
        onNavigate(previous);
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
  const title = article?.title ?? entry.title;
  const site = article?.site ?? entry.site;
  const author = article?.author ?? entry.author;
  const published = formatDate(article?.publishedAt ?? entry.publishedAt);
  const saved = formatDate(article?.savedAt ?? entry.savedAt);

  const readable = useMemo(() => (article ? toReadable(article.text, article.title, article.author) : null), [article]);
  const words = article ? wordCount(article.text) : (entry.wordCount ?? 0);
  const paywalled = article?.paywalled ?? entry.paywalled ?? false;

  const originalUrl = article?.originalUrl ?? entry.url;
  const permalink = article?.permalink ?? entry.permalink;
  // The feed's blurb stands in for the standfirst until the real text is here.
  const deck = readable ? readable.deck : entry.summary;
  const waiting = load.status === "fetching" || load.status === "loading";
  const elapsed = useElapsed(load.status === "fetching");


  return (
    <div className="reader" role="dialog" aria-modal="true" aria-label={title || "Article"}>
      <div className="reader-progress" ref={progressRef} />
      <div className="reader-bar">
        <button type="button" className="back-btn" onClick={onClose} title={`Back to ${backLabel} (Esc)`}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M15 5l-7 7 7 7" />
          </svg>
          {backLabel}
        </button>
        <span className="bar-spacer" />
        {position >= 0 && (
          <span className="meta bar-pos">
            {position + 1} of {list.length}
          </span>
        )}
        {position >= 0 && (
          <>
            <button type="button" className="icon-btn" disabled={!previous} onClick={() => previous && onNavigate(previous)} title="Previous article (k)" aria-label="Previous article">
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="m6 15 6-6 6 6" />
              </svg>
            </button>
            <button type="button" className="icon-btn" disabled={!next} onClick={() => next && onNavigate(next)} title="Next article (j)" aria-label="Next article">
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
        <article className="reader-article" key={entry.key}>
          {(title || load.status === "loading") && (
            <header className="reader-head">
              {site && site !== title && <p className="reader-site">{site}</p>}
              {title ? <h1 className="reader-title">{title}</h1> : <div className="sk-bar sk-title" />}
              {deck && <p className="reader-deck">{deck}</p>}
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

          {load.status === "fetching" && (
            <div className="reader-fetch" role="status" aria-live="polite">
              <span className="pulse-dot" aria-hidden="true" />
              <span className="reader-fetch-title">Fetching the full article…</span>
              <span className="meta reader-fetch-stage">
                {STAGE_TEXT[load.stage]}
                {elapsed >= 3 ? ` ${elapsed} s` : ""}
              </span>
            </div>
          )}

          {load.status === "idle" && (
            <div className="reader-fetch idle">
              <button type="button" className="solid-btn" onClick={() => startAttempt({ force: false, save: true })}>
                Fetch full article
              </button>
              <span className="reader-fetch-stage">
                Saves a readable copy to your Amber archive. Nothing is saved until you ask.
              </span>
            </div>
          )}

          {waiting && (
            <div className="reader-skeleton" aria-hidden="true">
              {Array.from({ length: 9 }, (_, i) => (
                <div key={i} className="sk-bar" style={{ width: i % 4 === 3 ? "58%" : "100%" }} />
              ))}
            </div>
          )}

          {load.status === "error" && (
            <div className="notice reader-notice" role="alert">
              <p className="notice-title">{load.title}</p>
              <p className="notice-body">{load.message}</p>
              <div className="notice-actions">
                {load.reason === "paywall-stub" ? (
                  <button type="button" className="ghost-btn" onClick={() => startAttempt({ force: true, save: true })}>
                    Try capturing again
                  </button>
                ) : (
                  <button
                    type="button"
                    className="ghost-btn"
                    onClick={() => startAttempt({ force: false, save: load.save === true })}
                  >
                    Try again
                  </button>
                )}
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
                <button type="button" className="next-card" onClick={() => onNavigate(next)}>
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
