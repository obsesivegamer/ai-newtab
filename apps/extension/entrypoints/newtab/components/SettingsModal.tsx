import { useEffect, useRef, useState } from "react";
import { MODEL_CHOICES, normalizeBlockList, type HomepageModel } from "@homepage/agent-core";
import { DEFAULT_ARCHIVE_URL, normalizeArchiveUrl } from "@/lib/archive";
import { REBUILD_INTERVAL_CHOICES } from "@/lib/auto-rebuild";
import { loadSettings, saveSetting } from "@/lib/storage";

type ArchiveCheck =
  | { state: "idle" }
  | { state: "testing" }
  | { state: "ok"; message: string }
  | { state: "error"; message: string };

const AMBER_DOWN = "Amber isn't running — start it with ./run.sh";

const NOT_AN_ADDRESS = "That doesn't look like a web address. Try http://127.0.0.1:8080";

/** One cheap read of the archive's list endpoint, turned into a sentence a person can act on. */
async function testArchive(base: string): Promise<ArchiveCheck> {
  let response: Response;
  try {
    response = await fetch(`${base}/api/snapshots?since_days=365&limit=1`, {
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
  onSave: (prompt: string, blockedSites: string[]) => void;
  /** False without an API key: saving can't start a build, so the button just says "Save". */
  canRebuild?: boolean;
}) {
  const saveLabel = canRebuild ? "Save & rebuild" : "Save";
  const [draft, setDraft] = useState(initialPrompt);
  const [blockedDraft, setBlockedDraft] = useState(blockedSites.join("\n"));
  const [archiveUrl, setArchiveUrl] = useState(DEFAULT_ARCHIVE_URL);
  const [archiveLoaded, setArchiveLoaded] = useState(false);
  const [archiveCheck, setArchiveCheck] = useState<ArchiveCheck>({ state: "idle" });
  /** Bumped whenever the field changes, a test starts, or the modal goes away; a late test result is ignored. */
  const archiveRequest = useRef(0);

  // Loaded here rather than threaded through App, which keeps this section self-contained.
  useEffect(() => {
    let cancelled = false;
    void loadSettings().then((s) => {
      if (cancelled) return;
      setArchiveUrl(s.archiveUrl);
      setArchiveLoaded(true);
    });
    return () => {
      cancelled = true;
      archiveRequest.current++;
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  /** The address as it should be saved: "" (archive off), a clean base URL, or null if it can't be one. */
  const archiveValue = (): string | null => (archiveUrl.trim() === "" ? "" : normalizeArchiveUrl(archiveUrl));

  // Like the prompt box, the address is a draft: it is written only when a test
  // succeeds or "Save & rebuild" is clicked, never by Cancel.
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
        message: `The archive is off. Click ${saveLabel} to use browsing history only.`,
      });
      return;
    }
    setArchiveCheck({ state: "testing" });
    const result = await testArchive(value);
    if (request !== archiveRequest.current) return;
    if (result.state === "ok") {
      await saveSetting("archiveUrl", value);
      if (request !== archiveRequest.current) return;
      setArchiveUrl(value);
    }
    setArchiveCheck(result);
  };

  const save = async () => {
    const value = archiveValue();
    if (value === null) {
      archiveRequest.current++;
      setArchiveCheck({ state: "error", message: NOT_AN_ADDRESS });
      return;
    }
    archiveRequest.current++;
    // Written before the rebuild starts, so the build reads the new address.
    if (archiveLoaded) await saveSetting("archiveUrl", value);
    onSave(draft, normalizeBlockList(blockedDraft.split("\n")));
  };

  const statusClass =
    archiveCheck.state === "ok" ? "ok" : archiveCheck.state === "error" ? "error" : "";

  return (
    <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <header className="modal-head">
          <h2 id="settings-title" className="modal-title">
            Settings
          </h2>
          <button
            type="button"
            className="icon-btn"
            onClick={onClose}
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
              Saved when a test succeeds or you click {saveLabel}.
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
          </section>
        </div>

        <footer className="modal-foot">
          <button type="button" className="ghost-btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="solid-btn" onClick={() => void save()}>
            {saveLabel}
          </button>
        </footer>
      </div>
    </div>
  );
}
