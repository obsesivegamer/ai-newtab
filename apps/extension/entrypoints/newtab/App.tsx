import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_MODEL,
  DEFAULT_BLOCKED_SITES,
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
import { SyncNote } from "./components/SyncNote";
import { ThemeToggle } from "./components/ThemeToggle";
import { ViewTabs, type View } from "./components/ViewTabs";
import { entryFromArchive, articleKey, type ReaderEntry } from "./readerEntry";
import { useTheme } from "./uiPrefs";
import { useArchiveList } from "./useArchiveList";
import { useHomepageBuild } from "./useHomepageBuild";
import { useHomepageOpen } from "./useHomepageOpen";

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
  /** A passing line shown when the sources list was replaced by the one Amber holds (edited on the phone). */
  const [syncNote, setSyncNote] = useState<string | null>(null);
  const clearSyncNote = useCallback(() => setSyncNote(null), []);
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

  // The model-built homepage may ask to open a story in the Reader: one gate, shared with the web app.
  const { reset: resetOpenRequests } = useHomepageOpen({
    canOpen: view === "today" && reader === null && !showSettings,
    blockedSites,
    onOpen: (entry) => setReader({ entry, list: [], origin: "today" }),
  });

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
    resetOpenRequests();
    setReader(null);
  }, [resetOpenRequests]);
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
          blockedSites={blockedSites}
          showAddress={reader.origin === "today"}
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
          onSourcesAdopted={() => {
            setSyncNote("Updated from your phone");
            setSourcesRev((n) => n + 1);
          }}
        />
      )}
      <SyncNote message={syncNote} onDone={clearSyncNote} />
    </div>
  );
}
