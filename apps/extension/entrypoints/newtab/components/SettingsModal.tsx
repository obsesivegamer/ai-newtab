import { useEffect, useRef, useState } from "react";
import { MODEL_CHOICES, normalizeBlockList, type HomepageModel } from "@homepage/agent-core";
import { DEFAULT_ARCHIVE_URL, normalizeArchiveUrl } from "@/lib/archive";
import { REBUILD_INTERVAL_CHOICES } from "@/lib/auto-rebuild";
import { loadSettings, saveSetting } from "@/lib/storage";
import { btn } from "./ui";

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
}) {
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
        message: "The archive is off. Click Save & rebuild to use browsing history only.",
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

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        backgroundColor: "rgba(0,0,0,0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div style={{ backgroundColor: "white", borderRadius: 8, padding: 24, width: "90%", maxWidth: 600, maxHeight: "90vh", overflowY: "auto" }}>
        <h2 style={{ marginTop: 0, color: "#333" }}>Customize your homepage</h2>
        <p style={{ color: "#666" }}>Standing instructions applied to every build.</p>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="e.g. 'Focus on tech news and Rust releases', 'Always surface unread GitHub PRs first'"
          style={{
            width: "100%",
            minHeight: 200,
            padding: 12,
            fontSize: 14,
            borderRadius: 4,
            border: "1px solid #ddd",
            fontFamily: "inherit",
          }}
        />
        <label style={{ display: "block", marginTop: 16, color: "#333", fontSize: 14 }}>
          Sites the agent never reads
          <textarea
            value={blockedDraft}
            onChange={(e) => setBlockedDraft(e.target.value)}
            aria-describedby="blocked-sites-help"
            style={{ width: "100%", boxSizing: "border-box", minHeight: 120, marginTop: 8, padding: 12, fontSize: 14, borderRadius: 4, border: "1px solid #ddd", fontFamily: "inherit" }}
          />
        </label>
        <p id="blocked-sites-help" style={{ color: "#888", fontSize: 12, margin: "6px 0 0" }}>
          One per line. Subdomains are included. Use *.example.com for wildcards.
        </p>
        <label
          style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 16, color: "#333", fontSize: 14 }}
        >
          Model
          <select
            value={model}
            onChange={(e) => onChangeModel(e.target.value as HomepageModel)}
            style={{ padding: "4px 8px", fontSize: 14, borderRadius: 4, border: "1px solid #ddd" }}
          >
            {MODEL_CHOICES.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginTop: 16,
            color: "#333",
            fontSize: 14,
            cursor: "pointer",
          }}
        >
          <input
            type="checkbox"
            checked={autoRebuild}
            onChange={(e) => onToggleAutoRebuild(e.target.checked)}
          />
          Rebuild automatically
        </label>
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginTop: 10,
            marginLeft: 24,
            color: autoRebuild ? "#333" : "#aaa",
            fontSize: 14,
          }}
        >
          Every
          <select
            value={intervalHours}
            disabled={!autoRebuild}
            onChange={(e) => onChangeInterval(Number(e.target.value))}
            style={{ padding: "4px 8px", fontSize: 14, borderRadius: 4, border: "1px solid #ddd" }}
          >
            {REBUILD_INTERVAL_CHOICES.map((h) => (
              <option key={h} value={h}>
                {h === 24 ? "24 hours (daily)" : `${h} hours`}
              </option>
            ))}
          </select>
        </label>
        <p style={{ color: "#888", fontSize: 12, margin: "6px 0 0" }}>
          When on, the extension rebuilds in the background once your homepage is this old, so
          your next tab shows a fresh one (uses your API key).
        </p>
        <h3 style={{ margin: "24px 0 0", color: "#333", fontSize: 15 }}>Article archive (Amber)</h3>
        <label style={{ display: "block", marginTop: 8, color: "#333", fontSize: 14 }}>
          Archive address
          <input
            type="url"
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
            style={{ width: "100%", boxSizing: "border-box", marginTop: 8, padding: "8px 12px", fontSize: 14, borderRadius: 4, border: "1px solid #ddd", fontFamily: "inherit" }}
          />
        </label>
        <p id="archive-help" style={{ color: "#888", fontSize: 12, margin: "6px 0 0" }}>
          Where your saved articles live. Leave empty to build from browsing history only. Saved
          when a test succeeds or you click Save &amp; rebuild.
        </p>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 10 }}>
          <button
            onClick={() => void runArchiveTest()}
            disabled={!archiveLoaded || archiveCheck.state === "testing"}
            style={{ ...btn, backgroundColor: "white", color: "#333", border: "1px solid #ddd" }}
          >
            {archiveCheck.state === "testing" ? "Testing…" : "Test connection"}
          </button>
          <span
            role="status"
            style={{
              fontSize: 13,
              color: archiveCheck.state === "ok" ? "#2e7d32" : archiveCheck.state === "error" ? "#a02620" : "#888",
            }}
          >
            {archiveCheck.state === "ok" || archiveCheck.state === "error" ? archiveCheck.message : ""}
          </span>
        </div>
        <div style={{ display: "flex", gap: 12, marginTop: 20, justifyContent: "flex-end" }}>
          <button
            onClick={onClose}
            style={{ ...btn, backgroundColor: "white", color: "#333", border: "1px solid #ddd" }}
          >
            Cancel
          </button>
          <button
            onClick={() => void save()}
            style={btn}
          >
            Save &amp; rebuild
          </button>
        </div>
      </div>
    </div>
  );
}
