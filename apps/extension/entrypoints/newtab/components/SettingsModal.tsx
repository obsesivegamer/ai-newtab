import { useEffect, useRef, useState } from "react";
import {
  MODEL_CHOICES,
  normalizeArchiveUrl,
  normalizeBlockList,
  type FeedSource,
  type HomepageModel,
} from "@homepage/agent-core";
import { DEFAULT_ARCHIVE_URL } from "@/lib/archive";
import { archiveGetInit, DEFAULT_FALLBACK_ARCHIVE_URL, type ArchiveAuth } from "@/lib/archive-auth";
import { REBUILD_INTERVAL_CHOICES } from "@/lib/auto-rebuild";
import { probeFeed } from "@/lib/feeds";
import { fetchRemoteSources, isShareableArchiveHost, loadSourcesStamp, publishSources } from "@/lib/phone-sync";
import {
  addFeedUrl,
  isSourceBlocked,
  loadSources,
  mergeSeeded,
  saveSources,
  seedFromArchive,
} from "@/lib/sources";
import { loadSettings, saveSetting } from "@/lib/storage";

type ArchiveCheck =
  | { state: "idle" }
  | { state: "testing" }
  | { state: "ok"; message: string }
  | { state: "error"; message: string };

const AMBER_DOWN = "Amber isn't running — start it (its run script or launchd service)";

const NOT_AN_ADDRESS = "That doesn't look like a web address. Try http://127.0.0.1:8080";

/**
 * Auth for a connection test. The Mac address never gets the reader password.
 * An address that is the offline reader does, when a password is set.
 */
function authForAddress(base: string, fallback: string, password: string): ArchiveAuth {
  const fallbackBase = fallback.trim() === "" ? "" : (normalizeArchiveUrl(fallback) ?? "");
  let targetsReader = false;
  try {
    targetsReader = Boolean(fallbackBase) && new URL(base).origin === new URL(fallbackBase).origin;
  } catch {
    targetsReader = false;
  }
  return { macBase: targetsReader ? "" : base, fallbackBase, password };
}

/** One cheap read of the archive's list endpoint, turned into a sentence a person can act on. */
async function testArchive(base: string, auth: ArchiveAuth): Promise<ArchiveCheck> {
  const url = `${base}/api/snapshots?since_days=365&limit=1`;
  const gated = archiveGetInit(url, auth);
  let response: Response;
  try {
    response = await fetch(url, {
      ...gated,
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    return { state: "error", message: AMBER_DOWN };
  }
  if (response.status === 404) {
    return {
      state: "error",
      message: "Something answered, but it has no article API. Check the address, or update Amber.",
    };
  }
  if (!response.ok) {
    return { state: "error", message: `Amber answered with an error (${response.status}). Try again in a moment.` };
  }
  try {
    const body = (await response.json()) as { total_usable?: unknown };
    if (typeof body.total_usable !== "number") throw new Error("unexpected shape");
    const n = body.total_usable;
    return {
      state: "ok",
      message:
        n === 0
          ? "Connected, but no readable articles were saved in the last year."
          : `Connected. ${n} readable article${n === 1 ? "" : "s"} saved in the last year.`,
    };
  } catch {
    return {
      state: "error",
      message: "Something answered, but it isn't Amber's article API. Check the address.",
    };
  }
}

export function SettingsModal({
  initialPrompt,
  blockedSites,
  model,
  onChangeModel,
  autoRebuild,
  onToggleAutoRebuild,
  intervalHours,
  onChangeInterval,
  onClose,
  onSave,
  canRebuild = true,
  onSourcesAdopted,
}: {
  initialPrompt: string;
  blockedSites: string[];
  model: HomepageModel;
  onChangeModel: (next: HomepageModel) => void;
  autoRebuild: boolean;
  onToggleAutoRebuild: (next: boolean) => void;
  intervalHours: number;
  onChangeInterval: (next: number) => void;
  onClose: () => void;
  onSave: (prompt: string, blockedSites: string[], rebuild: boolean) => void;
  /** False without an API key: there is nothing to rebuild with, so only "Save" is offered. */
  canRebuild?: boolean;
  /** A Save found Amber holding a newer sources list (edited on the phone) and took it as the list. */
  onSourcesAdopted?: () => void;
}) {
  const [draft, setDraft] = useState(initialPrompt);
  const [blockedDraft, setBlockedDraft] = useState(blockedSites.join("\n"));
  // A rebuild is paid for, so it is only offered when what the model reads actually changed:
  // the standing instructions or the blocked list. Sources and the archive address don't need one.
  const rebuildMeaningful =
    canRebuild &&
    (draft !== initialPrompt ||
      normalizeBlockList(blockedDraft.split("\n")).join("\n") !== normalizeBlockList(blockedSites).join("\n"));
  const [archiveUrl, setArchiveUrl] = useState(DEFAULT_ARCHIVE_URL);
  const [fallbackUrl, setFallbackUrl] = useState(DEFAULT_FALLBACK_ARCHIVE_URL);
  const [readerPassword, setReaderPassword] = useState("");
  const [archiveLoaded, setArchiveLoaded] = useState(false);
  /** What was last loaded or written, so closing can tell a draft from a saved password. */
  const savedArchive = useRef(DEFAULT_ARCHIVE_URL);
  const savedFallback = useRef(DEFAULT_FALLBACK_ARCHIVE_URL);
  const savedPassword = useRef("");
  const [archiveCheck, setArchiveCheck] = useState<ArchiveCheck>({ state: "idle" });
  /** Bumped whenever the field changes, a test starts, or the modal goes away; a late test result is ignored. */
  const archiveRequest = useRef(0);
  /** The sources list is a draft too: null while loading, written only by Save. */
  const [sources, setSources] = useState<FeedSource[] | null>(null);
  const [sourcesDirty, setSourcesDirty] = useState(false);
  const [sourcesError, setSourcesError] = useState<string | null>(null);
  const [feedInput, setFeedInput] = useState("");
  const [sourceCheck, setSourceCheck] = useState<ArchiveCheck>({ state: "idle" });
  /** Bumped when the modal goes away, so a late probe or re-seed doesn't touch a dead component. */
  const sourcesRequest = useRef(0);
  /** The latest draft and dirty flag, for async work that finishes after the person has kept editing. */
  const sourcesRef = useRef(sources);
  sourcesRef.current = sources;
  const sourcesDirtyRef = useRef(sourcesDirty);
  sourcesDirtyRef.current = sourcesDirty;
  /** Amber's stamp for the list that was adopted into the draft; the push on Save is conditional on it. */
  const remoteStamp = useRef<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    loadSources().then(
      (list) => {
        if (!cancelled) setSources((current) => current ?? list);
      },
      () => {
        if (cancelled) return;
        setSources((current) => current ?? []);
        setSourcesError("Couldn't read your saved sources. You can still add some below.");
      },
    );
    return () => {
      cancelled = true;
      sourcesRequest.current++;
    };
  }, []);

  // Loaded here rather than threaded through App, which keeps this section self-contained.
  useEffect(() => {
    let cancelled = false;
    void loadSettings().then((s) => {
      if (cancelled) return;
      savedArchive.current = s.archiveUrl;
      savedFallback.current = s.fallbackArchiveUrl;
      savedPassword.current = s.readerPassword;
      setArchiveUrl(s.archiveUrl);
      setFallbackUrl(s.fallbackArchiveUrl);
      setReaderPassword(s.readerPassword);
      setArchiveLoaded(true);
    });
    return () => {
      cancelled = true;
      archiveRequest.current++;
    };
  }, []);

  // The phone may have edited the list since this device last saw it. If Amber's stamp differs, its
  // list goes into the draft (Save keeps it, Cancel drops it). Best-effort and silent when Amber is
  // unreachable; a draft the person has already edited is left alone.
  useEffect(() => {
    if (!archiveLoaded) return;
    const base = normalizeArchiveUrl(archiveUrl);
    // Same rule as the push: a host this Mac never shares with also never stores a stamp, so
    // every open would look "changed" and replace the draft with that host's list.
    if (!base || !isShareableArchiveHost(new URL(base).hostname)) return;
    const controller = new AbortController();
    void (async () => {
      const remote = await fetchRemoteSources(base, controller.signal);
      if (remote.status !== "list" || remote.readOnly || !remote.updatedAt || controller.signal.aborted) return;
      if (remote.updatedAt === (await loadSourcesStamp())) return;
      if (controller.signal.aborted || sourcesDirtyRef.current) return;
      remoteStamp.current = remote.updatedAt;
      setSources(remote.sources);
      setSourcesDirty(true);
      setSourceCheck((current) =>
        current.state === "testing"
          ? current
          : { state: "ok", message: "Updated from your phone. Click Save to keep it." },
      );
    })();
    return () => controller.abort();
    // Once, when the address has loaded: later edits to the field don't re-read.
  }, [archiveLoaded]);

  const formDirty = (): boolean => {
    if (draft !== initialPrompt) return true;
    if (normalizeBlockList(blockedDraft.split("\n")).join("\n") !== normalizeBlockList(blockedSites).join("\n")) {
      return true;
    }
    if (sourcesDirty) return true;
    if (!archiveLoaded) return false;
    return (
      archiveUrl !== savedArchive.current ||
      fallbackUrl !== savedFallback.current ||
      readerPassword !== savedPassword.current
    );
  };
  const dirtyRef = useRef(false);
  dirtyRef.current = formDirty();
  const saveRef = useRef<(rebuild: boolean) => Promise<void>>(async () => {});
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  const requestClose = () => {
    if (dirtyRef.current) {
      if (window.confirm("You have unsaved changes. Save them before closing?")) {
        void saveRef.current(false);
        return;
      }
    }
    closeRef.current();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") requestClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  /** The address as it should be saved: "" (archive off), a clean base URL, or null if it can't be one. */
  const archiveValue = (): string | null => (archiveUrl.trim() === "" ? "" : normalizeArchiveUrl(archiveUrl));
  /** "" turns the fallback off. null means the draft is not an address. */
  const fallbackValue = (): string | null => (fallbackUrl.trim() === "" ? "" : normalizeArchiveUrl(fallbackUrl));

  /** Writes the Mac address, the fallback address, and the reader password. False when a draft is not an address. */
  const persistArchive = async (): Promise<boolean> => {
    const value = archiveValue();
    const fallback = fallbackValue();
    if (value === null) {
      archiveRequest.current++;
      setArchiveCheck({ state: "error", message: NOT_AN_ADDRESS });
      return false;
    }
    if (fallback === null) {
      archiveRequest.current++;
      setArchiveCheck({
        state: "error",
        message: `That doesn't look like a web address. Try ${DEFAULT_FALLBACK_ARCHIVE_URL}`,
      });
      return false;
    }
    if (archiveLoaded) {
      await saveSetting("archiveUrl", value);
      await saveSetting("fallbackArchiveUrl", fallback);
      await saveSetting("readerPassword", readerPassword);
      savedArchive.current = value;
      savedFallback.current = fallback;
      savedPassword.current = readerPassword;
    }
    return true;
  };

  // A successful test writes the Mac address and the reader password (and a valid
  // fallback). Esc and Cancel ask before dropping anything still unsaved.
  const runArchiveTest = async () => {
    const value = archiveValue();
    const request = ++archiveRequest.current;
    if (value === null) {
      setArchiveCheck({ state: "error", message: NOT_AN_ADDRESS });
      return;
    }
    if (value === "") {
      setArchiveCheck({
        state: "ok",
        message: `The archive is off. Click Save to use browsing history only.`,
      });
      return;
    }
    setArchiveCheck({ state: "testing" });
    const fallback = fallbackValue();
    const result = await testArchive(value, authForAddress(value, fallback ?? "", readerPassword));
    if (request !== archiveRequest.current) return;
    if (result.state === "ok") {
      await saveSetting("archiveUrl", value);
      savedArchive.current = value;
      if (fallback !== null) {
        await saveSetting("fallbackArchiveUrl", fallback);
        savedFallback.current = fallback;
      }
      await saveSetting("readerPassword", readerPassword);
      savedPassword.current = readerPassword;
      if (request !== archiveRequest.current) return;
      setArchiveUrl(value);
      if (fallback !== null) setFallbackUrl(fallback);
    }
    setArchiveCheck(result);
  };

  const save = async (rebuild: boolean) => {
    const value = archiveValue();
    if (!(await persistArchive())) return;
    archiveRequest.current++;
    // The archive fields are already written, so the build reads the new address.
    const blockedNow = normalizeBlockList(blockedDraft.split("\n"));
    if (sources && sourcesDirty) await saveSources(sources);
    // The phone/web version reads the same list from Amber. Best-effort and never awaited. Sources on
    // the blocked list are left out, so the phone never receives a publisher blocked here; a change to
    // that list alone republishes for the same reason.
    const blockedChanged = blockedNow.join("\n") !== normalizeBlockList(blockedSites).join("\n");
    if (sources && value && (sourcesDirty || blockedChanged)) {
      const shared = sources.filter((s) => !isSourceBlocked(s, blockedNow));
      const condition = remoteStamp.current === undefined ? {} : { ifUpdatedAt: remoteStamp.current };
      void publishSources(value, shared, condition).then((result) => {
        if (result.status === "conflict") onSourcesAdopted?.();
      });
    }
    onSave(draft, blockedNow, rebuild && rebuildMeaningful);
  };
  saveRef.current = save;

  const statusClass =
    archiveCheck.state === "ok" ? "ok" : archiveCheck.state === "error" ? "error" : "";
  const sourceStatusClass =
    sourceCheck.state === "ok" ? "ok" : sourceCheck.state === "error" ? "error" : "";

  const editSources = (next: FeedSource[]) => {
    setSources(next);
    setSourcesDirty(true);
  };

  const addSource = async () => {
    const address = feedInput.trim();
    if (!address || !sources || sourceCheck.state === "testing") return;
    if (!/^https?:\/\//i.test(address)) {
      setSourceCheck({ state: "error", message: "Paste a full address starting with https://" });
      return;
    }
    const request = ++sourcesRequest.current;
    setSourceCheck({ state: "testing" });
    try {
      const found = await probeFeed(address);
      if (request !== sourcesRequest.current) return;
      editSources(addFeedUrl(sourcesRef.current ?? sources, found.feedUrl));
      setFeedInput("");
      setSourceCheck({
        state: "ok",
        message: `Added. ${found.itemCount} article${found.itemCount === 1 ? "" : "s"} in that feed. Click Save to keep it.`,
      });
    } catch (err) {
      if (request !== sourcesRequest.current) return;
      setSourceCheck({ state: "error", message: err instanceof Error ? err.message : String(err) });
    }
  };

  const reseed = async () => {
    if (!sources || sourceCheck.state === "testing") return;
    const value = archiveValue();
    if (value === null) {
      setSourceCheck({ state: "error", message: NOT_AN_ADDRESS });
      return;
    }
    const request = ++sourcesRequest.current;
    setSourceCheck({ state: "testing" });
    const seeded = await seedFromArchive(value);
    if (request !== sourcesRequest.current) return;
    const { sources: merged, added } = mergeSeeded(sourcesRef.current ?? sources, seeded.sources);
    if (added.length > 0) editSources(merged);
    const skipped = seeded.skipped.length
      ? ` No known feed for ${seeded.skipped.slice(0, 4).join(", ")}${seeded.skipped.length > 4 ? ` and ${seeded.skipped.length - 4} more` : ""}; add their feed addresses above.`
      : "";
    if (seeded.archiveError && added.length === 0) {
      setSourceCheck({ state: "error", message: `${AMBER_DOWN}.${skipped}` });
    } else if (added.length === 0) {
      setSourceCheck({
        state: "ok",
        message: `Nothing new: your list already covers your archive.${skipped}`,
      });
    } else {
      setSourceCheck({
        state: "ok",
        message: `Added ${added.length}: ${added.map((a) => a.name).join(", ")}. Click Save to keep ${added.length === 1 ? "it" : "them"}.${skipped}`,
      });
    }
  };

  return (
    <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && requestClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <header className="modal-head">
          <h2 id="settings-title" className="modal-title">
            Settings
          </h2>
          <button
            type="button"
            className="icon-btn"
            onClick={requestClose}
            title="Close"
            aria-label="Close settings"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        </header>

        <div className="modal-body">
          <section className="set">
            <label className="set-title" htmlFor="set-prompt">
              Instructions
            </label>
            <p className="set-hint">Standing instructions applied to every build.</p>
            <textarea
              id="set-prompt"
              className="field area"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="e.g. 'Focus on tech news and Rust releases', 'Always surface unread GitHub PRs first'"
            />
          </section>

          <section className="set">
            <label className="set-title" htmlFor="set-blocked">
              Sites the agent never reads
            </label>
            <p id="blocked-sites-help" className="set-hint">
              One per line. Subdomains are included. Use *.example.com for wildcards.
            </p>
            <textarea
              id="set-blocked"
              className="field area mono"
              value={blockedDraft}
              onChange={(e) => setBlockedDraft(e.target.value)}
              aria-describedby="blocked-sites-help"
              spellCheck={false}
            />
          </section>

          <section className="set">
            <label className="set-title" htmlFor="set-model">
              Model
            </label>
            <p className="set-hint">Used for the next build.</p>
            <div className="select-wrap">
              <select
                id="set-model"
                className="field"
                value={model}
                onChange={(e) => onChangeModel(e.target.value as HomepageModel)}
              >
                {MODEL_CHOICES.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </div>
          </section>

          <section className="set">
            <h3 className="set-title">Rebuild schedule</h3>
            <label className="set-row">
              <span>Rebuild automatically</span>
              <input
                type="checkbox"
                className="switch"
                checked={autoRebuild}
                onChange={(e) => onToggleAutoRebuild(e.target.checked)}
              />
            </label>
            <label className={`set-row${autoRebuild ? "" : " off"}`}>
              <span>Every</span>
              <span className="select-wrap">
                <select
                  className="field"
                  value={intervalHours}
                  disabled={!autoRebuild}
                  onChange={(e) => onChangeInterval(Number(e.target.value))}
                >
                  {REBUILD_INTERVAL_CHOICES.map((h) => (
                    <option key={h} value={h}>
                      {h === 24 ? "24 hours (daily)" : `${h} hours`}
                    </option>
                  ))}
                </select>
              </span>
            </label>
            <p className="set-hint after">
              When on, the extension rebuilds in the background once your homepage is this old, so
              your next tab shows a fresh one (uses your API key).
            </p>
          </section>

          <section className="set">
            <label className="set-title" htmlFor="set-archive">
              Article archive (Amber)
            </label>
            <p id="archive-help" className="set-hint">
              Where your saved articles live. Leave empty to build from browsing history only.
              Saved when a test succeeds or you click Save.
            </p>
            <input
              id="set-archive"
              type="url"
              className="field mono"
              value={archiveUrl}
              disabled={!archiveLoaded}
              onChange={(e) => {
                archiveRequest.current++;
                setArchiveUrl(e.target.value);
                setArchiveCheck({ state: "idle" });
              }}
              placeholder={DEFAULT_ARCHIVE_URL}
              aria-describedby="archive-help"
              spellCheck={false}
            />
            <div className="set-test">
              <button
                type="button"
                className="ghost-btn"
                onClick={() => void runArchiveTest()}
                disabled={!archiveLoaded || archiveCheck.state === "testing"}
              >
                {archiveCheck.state === "testing" ? "Testing…" : "Test connection"}
              </button>
              <span role="status" className={`set-status ${statusClass}`}>
                {archiveCheck.state === "ok" || archiveCheck.state === "error"
                  ? archiveCheck.message
                  : ""}
              </span>
            </div>
            <label className="set-title follow" htmlFor="set-fallback">
              Offline reader
            </label>
            <p id="fallback-help" className="set-hint">
              When the Mac archive doesn't answer, saved articles are read from here instead. Leave
              empty to turn that off. Saved when a test succeeds or you click Save.
            </p>
            <input
              id="set-fallback"
              type="url"
              className="field mono"
              value={fallbackUrl}
              disabled={!archiveLoaded}
              onChange={(e) => {
                archiveRequest.current++;
                setFallbackUrl(e.target.value);
                setArchiveCheck({ state: "idle" });
              }}
              placeholder={DEFAULT_FALLBACK_ARCHIVE_URL}
              aria-describedby="fallback-help"
              spellCheck={false}
            />
            <label className="set-title follow" htmlFor="set-reader-password">
              Reader password
            </label>
            <p id="reader-password-help" className="set-hint">
              Sent only to the offline reader, as the password for the user “amber”. Never sent to
              the Mac archive. Saved when a test succeeds or you click Save.
            </p>
            <input
              id="set-reader-password"
              type="password"
              className="field mono"
              value={readerPassword}
              disabled={!archiveLoaded}
              onChange={(e) => setReaderPassword(e.target.value)}
              aria-describedby="reader-password-help"
              autoComplete="off"
              spellCheck={false}
            />
          </section>

          <section className="set">
            <h3 className="set-title">Sources</h3>
            <p id="sources-help" className="set-hint">
              The publications the Latest view and Today pull current articles from, read from their
              public feeds. Changes are saved when you click Save.
            </p>
            {sources === null ? (
              <p className="src-empty" role="status">
                Loading your sources…
              </p>
            ) : sources.length === 0 ? (
              <p className="src-empty">
                No sources yet. Add a feed below, or re-seed from your archive.
              </p>
            ) : (
              <ul className="src-list" aria-describedby="sources-help">
                {sources.map((s) => (
                  <li key={s.id} className={`src-row${s.enabled ? "" : " off"}`}>
                    <div className="src-text">
                      <span className="src-name">{s.name}</span>
                      {s.feedUrls.length === 0 ? (
                        <span className="src-feed">No feed address</span>
                      ) : (
                        s.feedUrls.map((u) => (
                          <span key={u} className="src-feed" title={u}>
                            {u.replace(/^https?:\/\//i, "")}
                          </span>
                        ))
                      )}
                    </div>
                    <input
                      type="checkbox"
                      className="switch"
                      checked={s.enabled}
                      aria-label={`Include ${s.name}`}
                      onChange={(e) =>
                        editSources(
                          sources.map((x) => (x.id === s.id ? { ...x, enabled: e.target.checked } : x)),
                        )
                      }
                    />
                    <button
                      type="button"
                      className="ghost-btn small"
                      aria-label={`Remove ${s.name}`}
                      onClick={() => editSources(sources.filter((x) => x.id !== s.id))}
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {sourcesError && <p className="set-status error src-note">{sourcesError}</p>}
            <div className="src-add">
              <input
                type="url"
                className="field mono"
                value={feedInput}
                disabled={sources === null}
                onChange={(e) => {
                  setFeedInput(e.target.value);
                  if (sourceCheck.state !== "testing") setSourceCheck({ state: "idle" });
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void addSource();
                  }
                }}
                placeholder="https://example.com/feed.xml"
                aria-label="Feed address to add"
                spellCheck={false}
              />
              <button
                type="button"
                className="ghost-btn"
                onClick={() => void addSource()}
                disabled={sources === null || feedInput.trim() === "" || sourceCheck.state === "testing"}
              >
                Add
              </button>
            </div>
            <div className="set-test">
              <button
                type="button"
                className="ghost-btn"
                onClick={() => void reseed()}
                disabled={sources === null || sourceCheck.state === "testing"}
              >
                {sourceCheck.state === "testing" ? "Working…" : "Re-seed from my archive"}
              </button>
              <span role="status" className={`set-status ${sourceStatusClass}`}>
                {sourceCheck.state === "ok" || sourceCheck.state === "error" ? sourceCheck.message : ""}
              </span>
            </div>
          </section>
        </div>

        <footer className="modal-foot">
          <button type="button" className="ghost-btn" onClick={requestClose}>
            Cancel
          </button>
          {rebuildMeaningful ? (
            <>
              <button type="button" className="ghost-btn" onClick={() => void save(false)}>
                Save
              </button>
              <button
                type="button"
                className="solid-btn"
                onClick={() => void save(true)}
                title="Saves, then builds today's homepage again (uses your API key)"
              >
                Save &amp; rebuild
              </button>
            </>
          ) : (
            <button type="button" className="solid-btn" onClick={() => void save(false)}>
              Save
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
