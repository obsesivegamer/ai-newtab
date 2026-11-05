import { useEffect, useRef, useState } from "react";
import type { FeedSource } from "@homepage/agent-core";
import { probeFeed } from "@/lib/feeds";
import { addFeedUrl, loadSources, mergeSeeded, seedFromArchive } from "@/lib/sources";
import type { Theme } from "@newtab/uiPrefs";
import {
  flushSourcePush,
  holdRemoteRefresh,
  onSourcesAccess,
  onSourcesAdopted,
  refreshRemoteSources,
  saveAndPushSources,
  sourcesAreReadOnly,
  type SourcesAccess,
} from "./sync";

type Check = { state: "idle" } | { state: "testing" } | { state: "ok"; message: string } | { state: "error"; message: string };

/**
 * The phone's settings: theme and sources. There is no API key, no build and no model here,
 * and the archive is always the Amber this page came from. Edits to the sources are saved as
 * they are made (there is no Save button), and shared with the extension through Amber.
 */
export function WebSettings({
  origin,
  theme,
  onToggleTheme,
  onClose,
}: {
  origin: string;
  theme: Theme;
  onToggleTheme: () => void;
  /** `changed` is true when the sources list was edited, so Latest should refetch. */
  onClose: (changed: boolean) => void;
}) {
  const [sources, setSources] = useState<FeedSource[] | null>(null);
  const [access, setAccess] = useState<SourcesAccess>(sourcesAreReadOnly() ? "read_only" : "pending");
  const [error, setError] = useState<string | null>(null);
  const [feedInput, setFeedInput] = useState("");
  const [check, setCheck] = useState<Check>({ state: "idle" });
  const changed = useRef(false);
  const alive = useRef(true);
  const accessRef = useRef(access);
  accessRef.current = access;
  /** The list before this sheet's edits, so a refused write can be shown again. */
  const baseline = useRef<FeedSource[] | null>(null);
  /** The list as it is now. Async work (a probe, a re-seed) reads it when it finishes, never a copy from when it began. */
  const latest = useRef<FeedSource[] | null>(null);

  const show = (list: FeedSource[], fromUser = false) => {
    latest.current = list;
    if (!fromUser) baseline.current = list;
    setSources(list);
  };

  useEffect(() => {
    alive.current = true;
    loadSources().then(
      (list) => alive.current && latest.current === null && show(list),
      () => {
        if (!alive.current || latest.current !== null) return;
        show([]);
        setError("Couldn’t read your saved sources. You can still add some below.");
      },
    );
    // The Mac may have changed the list since this page last looked: take Amber's, if it differs.
    void refreshRemoteSources(origin).then((next) => {
      if (!alive.current) return;
      setAccess(next === "unknown" ? "writable" : next);
    });
    const stop = onSourcesAdopted((list) => alive.current && show(list));
    const stopAccess = onSourcesAccess((next) => {
      if (!alive.current) return;
      setAccess(next);
      if (next === "read_only" && baseline.current) show(baseline.current);
    });
    return () => {
      alive.current = false;
      stop();
      stopAccess();
    };
  }, [origin]);

  // A re-read must not swap the list while a feed address is being checked.
  useEffect(() => {
    holdRemoteRefresh(check.state === "testing");
    return () => holdRemoteRefresh(false);
  }, [check.state]);

  const close = () => {
    flushSourcePush();
    onClose(changed.current);
  };

  const edit = (change: (current: FeedSource[]) => FeedSource[]) => {
    if (accessRef.current !== "writable") return;
    const next = change(latest.current ?? []);
    changed.current = true;
    show(next, true);
    void saveAndPushSources(origin, next);
  };

  const add = async () => {
    const address = feedInput.trim();
    if (!address || !sources || check.state === "testing") return;
    if (!/^https?:\/\//i.test(address)) {
      setCheck({ state: "error", message: "Paste a full address starting with https://" });
      return;
    }
    setCheck({ state: "testing" });
    try {
      const found = await probeFeed(address);
      if (!alive.current) return;
      edit((current) => addFeedUrl(current, found.feedUrl));
      setFeedInput("");
      setCheck({
        state: "ok",
        message: `Added. ${found.itemCount} article${found.itemCount === 1 ? "" : "s"} in that feed.`,
      });
    } catch (err) {
      if (!alive.current) return;
      setCheck({ state: "error", message: err instanceof Error ? err.message : String(err) });
    }
  };

  const reseed = async () => {
    if (!sources || check.state === "testing") return;
    setCheck({ state: "testing" });
    const seeded = await seedFromArchive(origin);
    if (!alive.current) return;
    const { sources: merged, added } = mergeSeeded(latest.current ?? [], seeded.sources);
    if (added.length > 0) edit(() => merged);
    const skipped = seeded.skipped.length
      ? ` No known feed for ${seeded.skipped.slice(0, 4).join(", ")}${seeded.skipped.length > 4 ? ` and ${seeded.skipped.length - 4} more` : ""}; add their feed addresses above.`
      : "";
    if (seeded.archiveError && added.length === 0) {
      setCheck({ state: "error", message: `Couldn’t read your archive.${skipped}` });
    } else if (added.length === 0) {
      setCheck({ state: "ok", message: `Nothing new: your list already covers your archive.${skipped}` });
    } else {
      setCheck({
        state: "ok",
        message: `Added ${added.length}: ${added.map((a) => a.name).join(", ")}.${skipped}`,
      });
    }
  };

  const status = check.state === "ok" ? "ok" : check.state === "error" ? "error" : "";
  const readOnly = access === "read_only";
  const canEdit = access === "writable";

  return (
    <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && close()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <header className="modal-head">
          <h2 id="settings-title" className="modal-title">
            Settings
          </h2>
          <button type="button" className="icon-btn" onClick={close} title="Close" aria-label="Close settings">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        </header>

        <div className="modal-body">
          <section className="set">
            <h3 className="set-title">Appearance</h3>
            <label className="set-row">
              <span>Light theme</span>
              <input
                type="checkbox"
                className="switch"
                checked={theme === "light"}
                onChange={onToggleTheme}
                aria-label="Light theme"
              />
            </label>
          </section>

          <section className="set">
            <h3 className="set-title">Sources</h3>
            <p id="sources-help" className="set-hint">
              {readOnly
                ? "This reader only displays sources. Edits are made on your Mac."
                : "The publications Latest reads, from their public feeds. Changes save as you make them and are shared with the extension on your Mac."}
            </p>
            {sources === null ? (
              <p className="src-empty" role="status">
                Loading your sources…
              </p>
            ) : sources.length === 0 ? (
              <p className="src-empty">
                {readOnly
                  ? "No sources yet. Add them on your Mac."
                  : canEdit
                    ? "No sources yet. Add a feed below, or re-seed from your archive."
                    : "Loading your sources…"}
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
                        <>
                          <span className="src-feed" title={s.feedUrls.join("\n")}>
                            {s.feedUrls[0].replace(/^https?:\/\//i, "")}
                          </span>
                          {s.feedUrls.length > 1 && (
                            <span className="src-feed">+ {s.feedUrls.length - 1} more feed{s.feedUrls.length === 2 ? "" : "s"}</span>
                          )}
                        </>
                      )}
                    </div>
                    <input
                      type="checkbox"
                      className="switch"
                      checked={s.enabled}
                      disabled={!canEdit}
                      aria-label={`Include ${s.name}`}
                      onChange={(e) =>
                        edit((current) =>
                          current.map((x) => (x.id === s.id ? { ...x, enabled: e.target.checked } : x)),
                        )
                      }
                    />
                    {canEdit && (
                      <button
                        type="button"
                        className="ghost-btn small"
                        aria-label={`Remove ${s.name}`}
                        onClick={() => edit((current) => current.filter((x) => x.id !== s.id))}
                      >
                        Remove
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {error && <p className="set-status error src-note">{error}</p>}
            {canEdit && (
              <>
                <div className="src-add">
                  <input
                    type="url"
                    inputMode="url"
                    autoCapitalize="off"
                    autoCorrect="off"
                    className="field mono"
                    value={feedInput}
                    disabled={sources === null}
                    onChange={(e) => {
                      setFeedInput(e.target.value);
                      if (check.state !== "testing") setCheck({ state: "idle" });
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void add();
                      }
                    }}
                    placeholder="https://example.com/feed.xml"
                    aria-label="Feed address to add"
                    spellCheck={false}
                  />
                  <button
                    type="button"
                    className="ghost-btn"
                    onClick={() => void add()}
                    disabled={sources === null || feedInput.trim() === "" || check.state === "testing"}
                  >
                    Add
                  </button>
                </div>
                <div className="set-test">
                  <button
                    type="button"
                    className="ghost-btn"
                    onClick={() => void reseed()}
                    disabled={sources === null || check.state === "testing"}
                  >
                    {check.state === "testing" ? "Working…" : "Re-seed from my archive"}
                  </button>
                  <span role="status" className={`set-status ${status}`}>
                    {check.state === "ok" || check.state === "error" ? check.message : ""}
                  </span>
                </div>
              </>
            )}
          </section>

          <section className="set">
            <h3 className="set-title">This app</h3>
            <p className="set-hint">
              Reading from <span className="mono-inline">{origin}</span>. Building Today, your API key and
              “Capture with my browser” live in the extension on your Mac.
            </p>
          </section>
        </div>

        <footer className="modal-foot">
          <button type="button" className="solid-btn" onClick={close}>
            Done
          </button>
        </footer>
      </div>
    </div>
  );
}
