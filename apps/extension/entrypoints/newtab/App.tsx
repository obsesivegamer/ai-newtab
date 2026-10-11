import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_MODEL,
  DEFAULT_BLOCKED_SITES,
  isAllowedUrl,
  type ArchiveArticleMeta,
  type HomepageModel,
} from "@homepage/agent-core";
import { DEFAULT_REBUILD_INTERVAL_HOURS } from "@/lib/auto-rebuild";
import { BUILD_STEPS } from "@/lib/protocol";
import { KEYS, extensionStore, loadHomepage, loadSettings, saveSetting } from "@/lib/storage";
import { toRenderable } from "@/lib/transpile";
import { ApiKeySetup } from "./components/ApiKeySetup";
import { BuildProgress } from "./components/BuildProgress";
import { HomepagePreview } from "./components/HomepagePreview";
import { SettingsModal } from "./components/SettingsModal";
import { Latest } from "./components/Latest";
import { Library } from "./components/Library";
import { Reader } from "./components/Reader";
import { ThemeToggle } from "./components/ThemeToggle";
import { ViewTabs, type View } from "./components/ViewTabs";
import {
  entryFromArchive,
  entryFromId,
  entryFromUrl,
  articleKey,
  type ReaderEntry,
} from "./readerEntry";
import { useTheme } from "./uiPrefs";
import { useArchiveList } from "./useArchiveList";
import { useHomepageBuild } from "./useHomepageBuild";

/** What the model-built homepage may ask the page to open. Anything else is ignored. */
const OPEN_ARTICLE = "homepage:open-article";
const ARTICLE_ID = /^[A-Za-z0-9]{3,16}$/;
/** The same, for a story that is not in the archive: only an address. */
const OPEN_URL = "homepage:open-url";
const MAX_OPEN_URL_LENGTH = 2048;
/** At most this many open requests are looked at per second; a page cannot spam the reader. */
const MESSAGES_PER_SECOND = 3;

/** Where the reader was opened from, which decides its back label and where focus returns. */
type ReaderOrigin = "latest" | "library" | "today";
const BACK_LABEL: Record<ReaderOrigin, string> = { latest: "Latest", library: "Library", today: "Today" };

export default function App() {
  const [loading, setLoading] = useState(true);
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [systemPrompt, setSystemPrompt] = useState("");
  const [blockedSites, setBlockedSites] = useState<string[]>(DEFAULT_BLOCKED_SITES);
  const [model, setModel] = useState<HomepageModel>(DEFAULT_MODEL);
  const [autoRebuild, setAutoRebuild] = useState(true);
  const [intervalHours, setIntervalHours] = useState(DEFAULT_REBUILD_INTERVAL_HOURS);
  /** Transpiled homepage, ready for Sandpack. */
  const [renderedCode, setRenderedCode] = useState<string | null>(null);
  /** A session left mid-flight, offered as "Resume interrupted build". */
  const [resumable, setResumable] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  /** Expand the full progress view over an existing homepage. */
  const [viewProgress, setViewProgress] = useState(false);
  /** The error the user dismissed, so a stale banner doesn't linger. */
  const [dismissedError, setDismissedError] = useState<string | null>(null);

  const { theme, toggle: toggleTheme } = useTheme();
  const [view, setView] = useState<View>("latest");
  /** The Today pane mounts on first visit and then stays, so Sandpack isn't rebuilt on every switch. */
  const [todayMounted, setTodayMounted] = useState(false);
  /** null until settings load; "" means the archive is switched off. */
  const [archiveUrl, setArchiveUrl] = useState<string | null>(null);
  const [reader, setReader] = useState<{
    entry: ReaderEntry;
    list: ReaderEntry[];
    origin: ReaderOrigin;
  } | null>(null);
  /** The library row the keyboard cursor sits on; follows the reader's prev/next. */
  const [cursorId, setCursorId] = useState<string | null>(null);
  /** The same for the Latest list (feed item ids). */
  const [latestCursor, setLatestCursor] = useState<string | null>(null);
  /** Stories the reader saved to Amber this session, by link, so Latest marks them at once. */
  const [saved, setSaved] = useState<Map<string, ArchiveArticleMeta>>(() => new Map());
  /** Bumped when Settings closes: the sources may have changed. */
  const [sourcesRev, setSourcesRev] = useState(0);
  const archive = useArchiveList(archiveUrl);

  useEffect(() => {
    document.title = view === "today" ? "Today" : view === "latest" ? "Latest" : "Library";
    if (view === "today") setTodayMounted(true);
  }, [view]);

  const { state, build, cancel } = useHomepageBuild((code) => setRenderedCode(toRenderable(code)));

  // Once a build finishes, drop back to the homepage view.
  useEffect(() => {
    if (!state.running) setViewProgress(false);
  }, [state.running]);

  // Scheduled rebuilds are driven by the worker's alarm, not by opening a tab;
  // useHomepageBuild surfaces any build already in flight.
  useEffect(() => {
    (async () => {
      try {
        const [settings, homepage, activeSession] = await Promise.all([
          loadSettings(),
          loadHomepage(),
          extensionStore.get<string>(KEYS.activeSessionId),
        ]);
        setApiKey(settings.apiKey);
        setArchiveUrl(settings.archiveUrl);
        setSystemPrompt(settings.systemPrompt);
        setBlockedSites(settings.blockedSites);
        setModel(settings.model);
        setAutoRebuild(settings.autoRebuild);
        setIntervalHours(settings.rebuildIntervalHours ?? DEFAULT_REBUILD_INTERVAL_HOURS);
        setResumable(activeSession ?? null);
        if (homepage?.code) setRenderedCode(toRenderable(homepage.code));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // The settings modal may have changed the archive address.
  const settingsWasOpen = useRef(false);
  useEffect(() => {
    if (showSettings) {
      settingsWasOpen.current = true;
      return;
    }
    if (settingsWasOpen.current) {
      settingsWasOpen.current = false;
      setSourcesRev((n) => n + 1);
    }
    void loadSettings().then((s) => {
      setArchiveUrl(s.archiveUrl);
      setBlockedSites(s.blockedSites);
    });
  }, [showSettings]);

  // The message handler below is installed once, so it reads what it needs through refs.
  const viewRef = useRef(view);
  viewRef.current = view;
  const readerOpenRef = useRef(false);
  const settingsOpenRef = useRef(false);
  settingsOpenRef.current = showSettings;
  const blockedRef = useRef(blockedSites);
  blockedRef.current = blockedSites;
  /** The last open request let through, so an immediate repeat is dropped; cleared when the Reader closes. */
  const lastOpen = useRef({ key: "", at: 0 });

  // The model-built homepage asks to open a story in the native reader: an archived one by
  // id, or one that is not in the archive by address. It can only ever open the in-page
  // reader; it never navigates this page, opens a window, or saves anything by itself.
  useEffect(() => {
    const fromHomepage = (source: MessageEventSource | null) => {
      // Only the homepage's own Sandpack frame may ask; the model's code runs in there.
      const frames = document.querySelectorAll<HTMLIFrameElement>(".today-frame iframe");
      return Array.from(frames).some((frame) => frame.contentWindow !== null && frame.contentWindow === source);
    };
    let recent: number[] = [];

    const onMessage = (e: MessageEvent) => {
      const data = e.data as { type?: unknown; id?: unknown; url?: unknown } | null;
      if (!data || typeof data !== "object" || Array.isArray(data)) return;
      if (data.type !== OPEN_ARTICLE && data.type !== OPEN_URL) return;

      // The same gate for both: only the homepage's own frame, only while the Today tab is
      // showing (a hidden or covered frame can't have been clicked), and not on top of an
      // open Reader or Settings. Bursts are dropped and an immediate repeat is ignored.
      if (!fromHomepage(e.source)) return;
      if (viewRef.current !== "today" || readerOpenRef.current || settingsOpenRef.current) return;
      const now = Date.now();
      recent = recent.filter((t) => now - t < 1000);
      if (recent.length >= MESSAGES_PER_SECOND) return;
      recent.push(now);

      if (data.type === OPEN_ARTICLE) {
        if (typeof data.id !== "string" || !ARTICLE_ID.test(data.id)) return;
        const id = data.id;
        const last = lastOpen.current;
        if (last.key === `a:${id}` && now - last.at < 2000) return;
        lastOpen.current = { key: `a:${id}`, at: now };
        setReader({ entry: entryFromId(id), list: [], origin: "today" });
        return;
      }

      if (typeof data.url !== "string" || data.url.length === 0 || data.url.length > MAX_OPEN_URL_LENGTH) return;
      let parsed: URL;
      try {
        parsed = new URL(data.url);
      } catch {
        return;
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return;
      if (parsed.username || parsed.password) return;
      if (!isAllowedUrl(parsed.href, blockedRef.current)) return;
      // The model's links arrive with `'` percent-encoded; the publisher's address has the apostrophe.
      const href = parsed.href.replace(/%27/gi, "'");
      const last = lastOpen.current;
      if (last.key === `u:${href}` && now - last.at < 2000) return;
      lastOpen.current = { key: `u:${href}`, at: now };
      setReader({ entry: entryFromUrl(href), list: [], origin: "today" });
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const openLibraryArticle = useCallback((id: string, list: ArchiveArticleMeta[]) => {
    const entries = list.map(entryFromArchive);
    const entry = entries.find((e) => e.key === id);
    if (!entry) return;
    setReader({ entry, list: entries, origin: "library" });
    setCursorId(id);
  }, []);
  const openLatest = useCallback((entry: ReaderEntry, list: ReaderEntry[]) => {
    // Opened by a click or Enter on its row: this is the one story that may be saved. Entries
    // reached afterwards with j/k, the arrows or the next card come from `list` and may not.
    setReader({ entry: { ...entry, autoFetch: true }, list, origin: "latest" });
    setLatestCursor(entry.key.replace(/^feed:/, ""));
  }, []);
  const readerRef = useRef(reader);
  readerRef.current = reader;
  const navigateReader = useCallback((entry: ReaderEntry) => {
    const origin = readerRef.current?.origin;
    setReader((r) => (r ? { ...r, entry } : r));
    if (origin === "latest") setLatestCursor(entry.key.replace(/^feed:/, ""));
    else if (origin === "library") setCursorId(entry.key);
  }, []);
  const closeReader = useCallback(() => {
    // Closing is the person's answer to the last request: asking again right away is a new click.
    lastOpen.current = { key: "", at: 0 };
    setReader(null);
  }, []);
  const readerSaved = useCallback(
    (entry: ReaderEntry, meta: ArchiveArticleMeta, created: boolean) => {
      if (entry.url) {
        const key = articleKey(entry.url);
        setSaved((prev) => new Map(prev).set(key, meta));
      }
      if (created) archive.reload();
    },
    [archive.reload],
  );

  // Put keyboard focus back on the row the reader was opened from.
  const readerOpen = reader !== null;
  readerOpenRef.current = readerOpen;
  const openedFrom = useRef<ReaderOrigin>("library");
  if (reader) openedFrom.current = reader.origin;
  const wasReaderOpen = useRef(false);
  useEffect(() => {
    if (readerOpen) {
      wasReaderOpen.current = true;
      return;
    }
    if (!wasReaderOpen.current) return;
    wasReaderOpen.current = false;
    const id =
      openedFrom.current === "latest"
        ? latestCursor && `lrow-${latestCursor}`
        : openedFrom.current === "library"
          ? cursorId && `row-${cursorId}`
          : null;
    if (id) document.getElementById(id)?.focus({ preventScroll: true });
  }, [readerOpen]);

  const saveKey = useCallback(async (key: string) => {
    await saveSetting("apiKey", key);
    setApiKey(key);
  }, []);

  const savePrompt = useCallback(
    async (prompt: string, sites: string[], rebuild: boolean) => {
      await Promise.all([saveSetting("systemPrompt", prompt), saveSetting("blockedSites", sites)]);
      setBlockedSites(sites);
      setSystemPrompt(prompt);
      setShowSettings(false);
      // Only an explicit "Save & rebuild" starts a (paid) build; saving sources or the
      // archive address, or changing nothing the model reads, never does.
      if (rebuild && apiKey) {
        setRenderedCode(null);
        build();
      }
    },
    [build, apiKey],
  );

  // These persist immediately; the worker reads them on its next heartbeat or build.
  const changeModel = useCallback(async (next: HomepageModel) => {
    setModel(next);
    await saveSetting("model", next);
  }, []);
  const toggleAutoRebuild = useCallback(async (next: boolean) => {
    setAutoRebuild(next);
    await saveSetting("autoRebuild", next);
  }, []);
  const changeInterval = useCallback(async (next: number) => {
    setIntervalHours(next);
    await saveSetting("rebuildIntervalHours", next);
  }, []);

  const showError = state.error && dismissedError !== state.error;
  const todayBuilding = state.running;

  // --- the "Today" view: the model-built homepage, unchanged in behaviour ----
  const renderToday = () => {
    if (loading) return <div className="pane-msg">Loading…</div>;
    if (!apiKey) return <ApiKeySetup onSave={saveKey} />;

    // With no homepage to fall back to, a running build takes over the pane.
    if (state.running && (!renderedCode || viewProgress)) {
      return (
        <BuildProgress
          state={state}
          onCancel={cancel}
          onBack={renderedCode ? () => setViewProgress(false) : undefined}
        />
      );
    }

    if (!renderedCode) {
      return (
        <div className="gate">
          <div className="meta gate-eyebrow">Today</div>
          <h1 className="gate-title">Build your homepage</h1>
          <p className="gate-body">
            The agent reads your browsing history and your archive, opens the pages you actually
            follow, and writes a homepage from what it finds today.
          </p>
          {state.error && (
            <div className="banner error" role="alert">
              <b>Build failed.</b> {state.error}
            </div>
          )}
          <div className="gate-actions">
            <button className="solid-btn" onClick={() => build()}>
              Build today&apos;s homepage
            </button>
            {resumable && (
              <button className="ghost-btn" onClick={() => build({ resume: true })}>
                Resume interrupted build
              </button>
            )}
          </div>
        </div>
      );
    }

    return (
      <>
        {showError && (
          <div className="banner error banner-row" role="alert">
            <span>
              <b>Build failed.</b> {state.error}
            </span>
            <button className="ghost-btn small" onClick={() => build()}>
              Retry
            </button>
            <button
              className="icon-btn"
              onClick={() => setDismissedError(state.error)}
              title="Dismiss"
              aria-label="Dismiss"
            >
              ✕
            </button>
          </div>
        )}
        <div className="today-frame">
          <HomepagePreview code={renderedCode} />
        </div>
      </>
    );
  };

  const showRebuild = view === "today" && !loading && !!apiKey && !!renderedCode;
  const showTodayError = !!showError;

  return (
    <div className="shell">
      <div className="shell-content" aria-hidden={readerOpen || undefined} inert={readerOpen || undefined}>
        <header className="topbar">
          <ViewTabs
            view={view}
            onChange={setView}
            todayBusy={todayBuilding}
            todayError={showTodayError}
          />
          <span className="bar-spacer" />
          {showRebuild &&
            (state.running ? (
              // A build is running in the background (from here, another tab, or the
              // scheduled rebuild). Let the user watch it without losing this page.
              <button
                className="ghost-btn small building"
                onClick={() => setViewProgress(true)}
                title="View build progress"
              >
                <span className="pulse-dot" />
                Building… {Math.min(state.stepIndex + 1, BUILD_STEPS.length)}/{BUILD_STEPS.length}
              </button>
            ) : (
              <button className="ghost-btn small" onClick={() => build()} title="Rebuild now">
                Rebuild
              </button>
            ))}
          <button className="ghost-btn small" onClick={() => setShowSettings(true)} title="Settings">
            Settings
          </button>
          <ThemeToggle theme={theme} onToggle={toggleTheme} />
        </header>

        {showTodayError && view !== "today" && (
          <div className="banner error banner-row banner-slim" role="alert">
            <span className="banner-text">
              <b>Today&apos;s build failed.</b> {state.error}
            </span>
            <button className="ghost-btn small" onClick={() => setView("today")}>
              View
            </button>
            <button
              className="icon-btn"
              onClick={() => setDismissedError(state.error)}
              title="Dismiss"
              aria-label="Dismiss"
            >
              ✕
            </button>
          </div>
        )}

        <main className="main">
          <div className="view-latest" hidden={view !== "latest"}>
            <Latest
              archiveUrl={archiveUrl}
              active={view === "latest" && !readerOpen && !showSettings}
              reloadToken={sourcesRev}
              saved={saved}
              blockedSites={blockedSites}
              cursorId={latestCursor}
              onCursor={setLatestCursor}
              onOpen={openLatest}
              onOpenSettings={() => setShowSettings(true)}
            />
          </div>
          <div className="view-library" hidden={view !== "library"}>
            <Library
              state={archive.state}
              archiveUrl={archiveUrl}
              onReload={archive.reload}
              onOpen={openLibraryArticle}
              cursorId={cursorId}
              onCursor={setCursorId}
              keysActive={view === "library" && !readerOpen && !showSettings}
              onOpenSettings={() => setShowSettings(true)}
            />
          </div>
          {todayMounted && (
            <div className="today-pane" hidden={view !== "today"}>
              {renderToday()}
            </div>
          )}
        </main>
      </div>

      {reader && (
        <Reader
          entry={reader.entry}
          list={reader.list}
          archiveUrl={archiveUrl}
          theme={theme}
          backLabel={BACK_LABEL[reader.origin]}
          onToggleTheme={toggleTheme}
          onNavigate={navigateReader}
          onClose={closeReader}
          onSaved={readerSaved}
          keysActive={!showSettings}
        />
      )}

      {showSettings && (
        <SettingsModal
          initialPrompt={systemPrompt}
          blockedSites={blockedSites}
          model={model}
          onChangeModel={changeModel}
          autoRebuild={autoRebuild}
          onToggleAutoRebuild={toggleAutoRebuild}
          intervalHours={intervalHours}
          onChangeInterval={changeInterval}
          onClose={() => setShowSettings(false)}
          onSave={savePrompt}
          canRebuild={!!apiKey}
        />
      )}
    </div>
  );
}
