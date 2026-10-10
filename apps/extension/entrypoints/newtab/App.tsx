import { useCallback, useEffect, useState } from "react";
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
import { Library } from "./components/Library";
import { Reader } from "./components/Reader";
import { ThemeToggle } from "./components/ThemeToggle";
import { ViewTabs, type View } from "./components/ViewTabs";
import { useTheme } from "./uiPrefs";
import { useArchiveList } from "./useArchiveList";
import { useHomepageBuild } from "./useHomepageBuild";

/** What the model-built homepage may ask the page to open. Anything else is ignored. */
const OPEN_ARTICLE = "homepage:open-article";
const ARTICLE_ID = /^[A-Za-z0-9]{3,16}$/;

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
  const [view, setView] = useState<View>("library");
  /** null until settings load; "" means the archive is switched off. */
  const [archiveUrl, setArchiveUrl] = useState<string | null>(null);
  const [reader, setReader] = useState<{ id: string; list: ArchiveArticleMeta[] } | null>(null);
  /** The library row the keyboard cursor sits on; follows the reader's prev/next. */
  const [cursorId, setCursorId] = useState<string | null>(null);
  const archive = useArchiveList(archiveUrl);

  useEffect(() => {
    document.title = view === "today" ? "Today" : "Library";
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
  useEffect(() => {
    if (showSettings) return;
    void loadSettings().then((s) => setArchiveUrl(s.archiveUrl));
  }, [showSettings]);

  // The model-built homepage asks to open an archived story in the native reader.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const data = e.data as { type?: unknown; id?: unknown } | null;
      if (!data || typeof data !== "object" || data.type !== OPEN_ARTICLE) return;
      if (typeof data.id !== "string" || !ARTICLE_ID.test(data.id)) return;
      setReader({ id: data.id, list: [] });
      setCursorId(data.id);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const openArticle = useCallback((id: string, list: ArchiveArticleMeta[]) => {
    setReader({ id, list });
    setCursorId(id);
  }, []);
  const navigateReader = useCallback((id: string) => {
    setReader((r) => (r ? { ...r, id } : r));
    setCursorId(id);
  }, []);
  const closeReader = useCallback(() => setReader(null), []);

  const saveKey = useCallback(async (key: string) => {
    await saveSetting("apiKey", key);
    setApiKey(key);
  }, []);

  const savePrompt = useCallback(
    async (prompt: string, sites: string[]) => {
      await Promise.all([saveSetting("systemPrompt", prompt), saveSetting("blockedSites", sites)]);
      setBlockedSites(sites);
      setSystemPrompt(prompt);
      setShowSettings(false);
      if (apiKey) {
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
  const readerOpen = reader !== null;

  return (
    <div className="shell">
      <header className="topbar">
        <ViewTabs view={view} onChange={setView} todayBusy={todayBuilding} />
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

      <main className="main" aria-hidden={readerOpen || undefined} inert={readerOpen || undefined}>
        {view === "library" ? (
          <Library
            state={archive.state}
            archiveUrl={archiveUrl}
            onReload={archive.reload}
            onOpen={openArticle}
            cursorId={cursorId}
            onCursor={setCursorId}
            keysActive={!readerOpen && !showSettings}
            onOpenSettings={() => setShowSettings(true)}
          />
        ) : (
          <div className="today-pane">{renderToday()}</div>
        )}
      </main>

      {reader && (
        <Reader
          id={reader.id}
          list={reader.list}
          archiveUrl={archiveUrl}
          theme={theme}
          onToggleTheme={toggleTheme}
          onNavigate={navigateReader}
          onClose={closeReader}
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
        />
      )}
    </div>
  );
}
