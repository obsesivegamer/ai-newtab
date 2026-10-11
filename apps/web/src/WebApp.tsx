import { useCallback, useEffect, useRef, useState } from "react";
import { DEFAULT_BLOCKED_SITES, type ArchiveArticleMeta } from "@homepage/agent-core";
import { loadSettings } from "@/lib/storage";
import { Latest } from "@newtab/components/Latest";
import { Library } from "@newtab/components/Library";
import { Reader } from "@newtab/components/Reader";
import { SyncNote } from "@newtab/components/SyncNote";
import { ThemeToggle } from "@newtab/components/ThemeToggle";
import { ViewTabs, type View } from "@newtab/components/ViewTabs";
import { articleKey, entryFromArchive, type ReaderEntry } from "@newtab/readerEntry";
import { useTheme } from "@newtab/uiPrefs";
import { useArchiveList } from "@newtab/useArchiveList";
import { useHomepageOpen } from "@newtab/useHomepageOpen";
import { onSourcesAdopted } from "./sync";
import { TodayStatic } from "./TodayStatic";
import { WebSettings } from "./WebSettings";

type ReaderOrigin = "latest" | "library" | "today";
const BACK_LABEL: Record<ReaderOrigin, string> = { latest: "Latest", library: "Library", today: "Today" };
const TITLES: Record<View, string> = { latest: "Latest", library: "Library", today: "Today" };

/** Same Amber that served this page: no address to configure, and no CORS. */
const ORIGIN = location.origin;

/**
 * The phone/web version of the new tab: Latest, Library and Today (as built on the Mac),
 * and the same Reader. It is the extension's App without the build, the API key and the
 * service worker; every view is the extension's own component.
 */
export default function WebApp() {
  const { theme, toggle: toggleTheme } = useTheme();
  const [view, setView] = useState<View>("latest");
  const [todayMounted, setTodayMounted] = useState(false);
  const [blockedSites, setBlockedSites] = useState<string[]>(DEFAULT_BLOCKED_SITES);
  const [showSettings, setShowSettings] = useState(false);
  const [sourcesRev, setSourcesRev] = useState(0);
  const [syncNote, setSyncNote] = useState<string | null>(null);
  const clearSyncNote = useCallback(() => setSyncNote(null), []);
  const [reader, setReader] = useState<{ entry: ReaderEntry; list: ReaderEntry[]; origin: ReaderOrigin } | null>(null);
  const [cursorId, setCursorId] = useState<string | null>(null);
  const [latestCursor, setLatestCursor] = useState<string | null>(null);
  const [saved, setSaved] = useState<Map<string, ArchiveArticleMeta>>(() => new Map());
  const archive = useArchiveList(ORIGIN);

  useEffect(() => {
    void loadSettings().then((s) => setBlockedSites(s.blockedSites));
  }, []);

  // Another device (the Mac) changed the sources: Latest reads the new list, and a line says so.
  useEffect(
    () =>
      onSourcesAdopted(() => {
        setSourcesRev((n) => n + 1);
        setSyncNote("Updated from another device");
      }),
    [],
  );

  useEffect(() => {
    document.title = TITLES[view];
    if (view === "today") setTodayMounted(true);
  }, [view]);

  // The browser's chrome (status bar, address bar tint) follows the theme the person picked.
  useEffect(() => {
    const color = theme === "light" ? "#faf7f0" : "#161412";
    document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.remove());
    const meta = document.createElement("meta");
    meta.name = "theme-color";
    meta.content = color;
    document.head.appendChild(meta);
  }, [theme]);

  const readerOpen = reader !== null;

  // The model-built page may ask to open a story in the Reader: the same gate as the extension.
  const { reset: resetOpenRequests } = useHomepageOpen({
    canOpen: view === "today" && !readerOpen && !showSettings,
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
    // Opened by a tap on its row: this is the one story that may be saved. Entries reached
    // afterwards with prev/next come from `list` and may not.
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

  // Put focus back on the row the Reader was opened from (the list keeps its scroll position).
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

  const covered = readerOpen || showSettings;

  return (
    <div className="shell web-shell">
      <div className="shell-content" aria-hidden={covered || undefined} inert={covered || undefined}>
        <header className="topbar web-topbar">
          <span className="meta web-brand">AI Newspage</span>
          <span className="bar-spacer" />
          <button type="button" className="icon-btn" onClick={() => setShowSettings(true)} title="Settings" aria-label="Settings">
            <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M4 7h10M18 7h2M4 17h2M10 17h10" />
              <circle cx="16" cy="7" r="2" />
              <circle cx="8" cy="17" r="2" />
            </svg>
          </button>
          <ThemeToggle theme={theme} onToggle={toggleTheme} />
        </header>

        <main className="main">
          <div className="view-latest" hidden={view !== "latest"}>
            <Latest
              archiveUrl={ORIGIN}
              active={view === "latest" && !covered}
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
              archiveUrl={ORIGIN}
              onReload={archive.reload}
              onOpen={openLibraryArticle}
              cursorId={cursorId}
              onCursor={setCursorId}
              keysActive={view === "library" && !covered}
              onOpenSettings={() => setShowSettings(true)}
            />
          </div>
          {todayMounted && (
            <div className="today-pane" hidden={view !== "today"}>
              <TodayStatic origin={ORIGIN} active={view === "today" && !covered} />
            </div>
          )}
        </main>

        <div className="web-tabbar">
          <ViewTabs view={view} onChange={setView} todayBusy={false} todayError={false} />
        </div>
      </div>

      {reader && (
        <Reader
          entry={reader.entry}
          list={reader.list}
          archiveUrl={ORIGIN}
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
        <WebSettings
          origin={ORIGIN}
          theme={theme}
          onToggleTheme={toggleTheme}
          onClose={(changed) => {
            setShowSettings(false);
            if (changed) setSourcesRev((n) => n + 1);
          }}
        />
      )}
      <SyncNote message={syncNote} onDone={clearSyncNote} />
    </div>
  );
}
