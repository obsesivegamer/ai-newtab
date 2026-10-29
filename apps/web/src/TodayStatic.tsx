import { useCallback, useEffect, useRef, useState } from "react";
import { DEFAULT_FALLBACK_ARCHIVE_URL } from "@/lib/archive-auth";
import { fetchHomepage, requestHomepageRebuild, type HomepageFetch } from "@/lib/phone-sync";
import { toRenderable } from "@/lib/transpile";
import { canShowHomepagePreview } from "@newtab/components/homepagePreviewGate";
import { HomepagePreview } from "@newtab/components/HomepagePreview";
import {
  ASKED_MAC,
  REBUILD_EXPIRED,
  REBUILD_WAIT_TIMED_OUT,
  TODAY_POLL_LIMIT_MS,
  TODAY_POLL_MS,
  UNREADABLE_BUILD_TIME,
  builtClock,
  cooldownLabel,
  homepageArrived,
  isFreshPage,
  oldPageNote,
  shouldAskRebuild,
  timestampAdvanced,
  timestampParses,
  upToDateLabel,
} from "./todayStatus";

type State = { status: "loading" } | HomepageFetch;
type OkHomepage = Extract<HomepageFetch, { status: "ok" }>;

type Notice = "uptodate" | "updated" | "stale" | "cooldown" | "timeout" | "expired" | "failed" | "unreadable" | null;

const READER_APP_URL = `${DEFAULT_FALLBACK_ARCHIVE_URL}/app/`;

/**
 * Today on the phone: the page the extension built and handed to Amber, shown as it is.
 * No key and no model here. Refresh asks the Mac once the page is about an hour old.
 * "Rebuild on Mac" always asks. The preview only mounts in a secure context
 * (Sandpack needs `crypto.subtle`).
 */
export function TodayStatic({ origin, active }: { origin: string; active: boolean }) {
  const [state, setState] = useState<State>({ status: "loading" });
  const [code, setCode] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState(0);
  const [notice, setNotice] = useState<Notice>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [asked, setAsked] = useState(false);
  const [checking, setChecking] = useState(false);
  const [canRebuild, setCanRebuild] = useState(true);
  const [watch, setWatch] = useState<{ baseline: string; until: number } | null>(null);
  const showingGood = useRef(false);
  const shownTimestamp = useRef<string | null>(null);
  const rebuildUnsupported = useRef(false);
  const checkingRef = useRef(false);

  const applyOk = useCallback((result: OkHomepage) => {
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
        const previous = shownTimestamp.current;
        const advanced = previous !== null && timestampAdvanced(previous, result.homepage.timestamp);
        shownTimestamp.current = result.homepage.timestamp;
        setNotice((current) => {
          if (advanced) return "updated";
          if (current === "stale") return null;
          return current;
        });
        setCode((previous) => {
          const next = toRenderable(result.homepage.code);
          return previous === next ? previous : next;
        });
      }
      setState(result);
    },
    [origin],
  );

  const showIfNewer = useCallback(
    async (shown: OkHomepage, previous: string | null) => {
      const again = await fetchHomepage(origin);
      const page = again.status === "ok" ? again : shown;
      if (again.status === "ok") applyOk(again);
      const baseline = previous ?? shown.homepage.timestamp;
      if (again.status === "ok" && homepageArrived(baseline, page.homepage.timestamp)) {
        setNotice("updated");
        return;
      }
      if (page.homepage.rebuildRequest?.expired) {
        setNotice("expired");
        return;
      }
      if (!timestampParses(page.homepage.timestamp)) {
        setNotice("unreadable");
        return;
      }
      if (!oldPageNote(page.homepage.timestamp, page.homepage.syncedAt, Date.now())) setNotice("cooldown");
    },
    [applyOk, origin],
  );

  const askMac = useCallback(
    async (page: OkHomepage, previous: string | null) => {
      const posted = await requestHomepageRebuild(origin);
      if (posted.status === "missing") {
        rebuildUnsupported.current = true;
        setCanRebuild(false);
        return;
      }
      if (posted.status === "error") {
        setFailure(posted.message);
        setNotice("failed");
        return;
      }
      // `expired` is not a POST result. A fulfilled or cooling-down request is
      // already done: look once more, and don't start the ten-minute wait.
      if (posted.request.cooldown || posted.request.fulfilledAt) {
        await showIfNewer(page, previous);
        return;
      }
      setAsked(true);
      setWatch({ baseline: page.homepage.timestamp, until: Date.now() + TODAY_POLL_LIMIT_MS });
    },
    [origin, showIfNewer],
  );

  const run = useCallback(
    async (mode: "if-stale" | "always") => {
      if (checkingRef.current) return;
      checkingRef.current = true;
      setChecking(true);
      setNotice(null);
      setFailure(null);
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
        const now = Date.now();
        if (mode === "if-stale") {
          if (advanced) {
            setNotice("updated");
            return;
          }
          if (!timestampParses(result.homepage.timestamp)) {
            setNotice("unreadable");
            return;
          }
          if (isFreshPage(result.homepage.timestamp, now)) {
            setNotice("uptodate");
            return;
          }
          if (rebuildUnsupported.current || !shouldAskRebuild(result.homepage.timestamp, now)) return;
        } else if (rebuildUnsupported.current) {
          if (advanced) setNotice("updated");
          return;
        }
        await askMac(result, previous);
      } finally {
        checkingRef.current = false;
        setChecking(false);
      }
    },
    [applyOk, askMac, origin],
  );

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
        setAsked(false);
        setNotice("timeout");
        setWatch(null);
        return;
      }
      void fetchHomepage(origin).then((result) => {
        if (cancelled || result.status !== "ok") return;
        if (homepageArrived(watch.baseline, result.homepage.timestamp)) {
          applyOk(result);
          setNotice("updated");
          setAsked(false);
          setWatch(null);
          return;
        }
        if (result.homepage.rebuildRequest?.expired) {
          applyOk(result);
          setNotice("expired");
          setAsked(false);
          setWatch(null);
        }
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
    const now = Date.now();
    const status =
      notice === "uptodate" && !oldNote
        ? upToDateLabel(state.homepage.timestamp, now)
        : notice === "cooldown" && !oldNote
          ? cooldownLabel(state.homepage.timestamp, now)
          : notice === "updated"
            ? "Updated"
            : notice === "stale"
              ? "Couldn’t refresh — showing the last copy"
              : notice === "timeout"
                ? REBUILD_WAIT_TIMED_OUT
                : notice === "expired"
                  ? REBUILD_EXPIRED
                  : notice === "failed"
                    ? failure
                    : notice === "unreadable"
                      ? UNREADABLE_BUILD_TIME
                      : null;
    return (
      <>
        <div className="today-strip">
          <span className="meta today-built">{label ? `Built ${label} on your Mac` : "Built on your Mac"}</span>
          <span className="today-actions">
            <button type="button" className="ghost-btn small" onClick={() => void run("if-stale")} disabled={checking}>
              {checking ? "Checking…" : "Refresh"}
            </button>
            {canRebuild && (
              <button type="button" className="ghost-btn small" onClick={() => void run("always")} disabled={checking}>
                {checking ? "Checking…" : "Rebuild on Mac"}
              </button>
            )}
          </span>
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
              <a href={READER_APP_URL}>{READER_APP_URL}</a>
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
