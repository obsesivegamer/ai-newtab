import { useCallback, useEffect, useRef, useState } from "react";
import { DEFAULT_FALLBACK_ARCHIVE_URL } from "@/lib/archive-auth";
import { fetchHomepage, requestHomepageRebuild, type HomepageFetch } from "@/lib/phone-sync";
import { toRenderable } from "@/lib/transpile";
import { canShowHomepagePreview } from "@newtab/components/homepagePreviewGate";
import { HomepagePreview } from "@newtab/components/HomepagePreview";
import {
  ASKED_MAC,
  TODAY_POLL_LIMIT_MS,
  TODAY_POLL_MS,
  oldPageNote,
  shouldAskRebuild,
  timestampAdvanced,
  upToDateLabel,
  builtClock,
} from "./todayStatus";

type State = { status: "loading" } | HomepageFetch;

type Notice = "checking" | "uptodate" | "updated" | "stale" | null;

/**
 * Today on the phone: the page the extension built and handed to Amber, shown as it is.
 * No key and no model here. A refresh can ask the Mac to rebuild, and the preview
 * only mounts in a secure context (Sandpack needs `crypto.subtle`).
 */
export function TodayStatic({ origin, active }: { origin: string; active: boolean }) {
  const [state, setState] = useState<State>({ status: "loading" });
  const [code, setCode] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState(0);
  const [notice, setNotice] = useState<Notice>(null);
  const [asked, setAsked] = useState(false);
  const [checking, setChecking] = useState(false);
  const [watch, setWatch] = useState<{ baseline: string; until: number } | null>(null);
  const showingGood = useRef(false);
  const shownTimestamp = useRef<string | null>(null);
  const rebuildUnsupported = useRef(false);
  const checkingRef = useRef(false);

  const applyOk = useCallback((result: Extract<HomepageFetch, { status: "ok" }>) => {
    setLoadedAt(Date.now());
    showingGood.current = true;
    shownTimestamp.current = result.homepage.timestamp;
    setCode((previous) => {
      const next = toRenderable(result.homepage.code);
      return previous === next ? previous : next;
    });
    setState(result);
  }, []);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      const result = await fetchHomepage(origin, signal);
      if (signal?.aborted) return;
      setLoadedAt(Date.now());
      if (result.status === "error" && showingGood.current) {
        setNotice("stale");
        return;
      }
      showingGood.current = result.status === "ok";
      if (result.status === "ok") {
        shownTimestamp.current = result.homepage.timestamp;
        setNotice((current) => (current === "stale" ? null : current));
        setCode((previous) => {
          const next = toRenderable(result.homepage.code);
          return previous === next ? previous : next;
        });
      }
      setState(result);
    },
    [origin],
  );

  const refresh = useCallback(async () => {
    if (checkingRef.current) return;
    checkingRef.current = true;
    setChecking(true);
    setNotice("checking");
    setAsked(false);
    setWatch(null);
    const previous = shownTimestamp.current;
    try {
      const result = await fetchHomepage(origin);
      if (result.status !== "ok") {
        if (showingGood.current) setNotice("stale");
        else {
          setNotice(null);
          setLoadedAt(Date.now());
          setState(result);
        }
        return;
      }
      const advanced = previous !== null && timestampAdvanced(previous, result.homepage.timestamp);
      applyOk(result);
      const outcome = advanced ? "updated" : "uptodate";
      setNotice(outcome);
      const ask = !rebuildUnsupported.current && shouldAskRebuild(previous, result.homepage.timestamp, Date.now());
      if (!ask) return;
      const posted = await requestHomepageRebuild(origin);
      if (posted.status === "missing") {
        rebuildUnsupported.current = true;
        return;
      }
      if (posted.status !== "ok") return;
      setAsked(true);
      setWatch({ baseline: result.homepage.timestamp, until: Date.now() + TODAY_POLL_LIMIT_MS });
    } finally {
      checkingRef.current = false;
      setChecking(false);
    }
  }, [applyOk, origin]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  // Coming back to a page left open all day: pick up a rebuild without a manual refresh.
  useEffect(() => {
    if (!active) return;
    const onVisible = () => {
      if (!document.hidden && Date.now() - loadedAt > 5 * 60_000) void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    if (loadedAt && Date.now() - loadedAt > 5 * 60_000) void load();
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [active, loadedAt, load]);

  useEffect(() => {
    if (!watch) return;
    let cancelled = false;
    const timer = setInterval(() => {
      if (Date.now() >= watch.until) {
        clearInterval(timer);
        setWatch(null);
        return;
      }
      void fetchHomepage(origin).then((result) => {
        if (cancelled || result.status !== "ok") return;
        if (!timestampAdvanced(watch.baseline, result.homepage.timestamp)) return;
        applyOk(result);
        setNotice("updated");
        setAsked(false);
        setWatch(null);
      });
    }, TODAY_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [applyOk, origin, watch]);

  if (state.status === "loading") return <div className="pane-msg">Loading…</div>;

  if (state.status === "ok" && code) {
    const label = builtClock(state.homepage.timestamp);
    const oldNote = oldPageNote(state.homepage.timestamp, state.homepage.syncedAt, Date.now());
    const secure = canShowHomepagePreview();
    const status =
      notice === "uptodate"
        ? upToDateLabel(state.homepage.timestamp, Date.now())
        : notice === "updated"
          ? "Updated"
          : notice === "stale"
            ? "Couldn’t refresh — showing the last copy"
            : null;
    return (
      <>
        <div className="today-strip">
          <span className="meta today-built">{label ? `Built ${label} on your Mac` : "Built on your Mac"}</span>
          <button type="button" className="ghost-btn small" onClick={() => void refresh()} disabled={checking}>
            {checking ? "Checking…" : "Refresh"}
          </button>
        </div>
        {checking && (
          <p className="meta today-note" role="status">
            Checking…
          </p>
        )}
        {oldNote && (
          <p className="meta today-note" role="status">
            {oldNote}
          </p>
        )}
        {status && (
          <p className="meta today-note" role="status">
            {status}
          </p>
        )}
        {asked && (
          <p className="meta today-note" role="status">
            {ASKED_MAC}
          </p>
        )}
        {secure ? (
          <div className="today-frame">
            <HomepagePreview code={code} />
          </div>
        ) : (
          <div className="gate web-gate" role="alert">
            <div className="meta gate-eyebrow">Today</div>
            <h1 className="gate-title">Today needs HTTPS.</h1>
            <p className="gate-body">
              This page is not a secure context, so the preview can’t run. Open the reader over HTTPS.
            </p>
            <p className="gate-body">
              <a href={DEFAULT_FALLBACK_ARCHIVE_URL}>{DEFAULT_FALLBACK_ARCHIVE_URL}</a>
            </p>
          </div>
        )}
      </>
    );
  }

  const copy =
    state.status === "empty"
      ? {
          title: "No Today page yet.",
          body: "Build it once in the extension on your Mac.",
        }
      : state.status === "unsupported"
        ? {
            title: "This Amber can’t share Today yet.",
            body: "It has no homepage endpoint. Update Amber on your Mac and restart it.",
          }
        : {
            title: "Couldn’t reach Amber.",
            body: "Check that your Mac is on and Tailscale is connected, then try again.",
          };
  return (
    <div className="gate web-gate">
      <div className="meta gate-eyebrow">Today</div>
      <h1 className="gate-title">{copy.title}</h1>
      <p className="gate-body">{copy.body}</p>
      <div className="gate-actions">
        <button type="button" className="ghost-btn" onClick={() => void load()}>
          Check again
        </button>
      </div>
    </div>
  );
}
