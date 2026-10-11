import { useCallback, useEffect, useRef, useState } from "react";
import { fetchHomepage, type HomepageFetch } from "@/lib/phone-sync";
import { toRenderable } from "@/lib/transpile";
import { HomepagePreview } from "@newtab/components/HomepagePreview";

type State = { status: "loading" } | HomepageFetch;

const builtFormat = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

function builtLabel(timestamp: string): string | null {
  const d = new Date(timestamp);
  return Number.isNaN(d.getTime()) ? null : `Built ${builtFormat.format(d)} on your Mac`;
}

/**
 * Today on the phone: the page the extension built and handed to Amber, shown as it is.
 * No key, no build, no model here. It renders in the same sandboxed Sandpack frame as
 * the extension's (`HomepagePreview`); the open-article / open-url requests that frame
 * sends are handled by `useHomepageOpen` in the web app, under the same gate as the extension.
 */
export function TodayStatic({ origin, active }: { origin: string; active: boolean }) {
  const [state, setState] = useState<State>({ status: "loading" });
  const [code, setCode] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState(0);
  /** The last refresh failed while a good page was showing; the page stays, with a note. */
  const [staleNote, setStaleNote] = useState(false);
  const showingGood = useRef(false);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      const result = await fetchHomepage(origin, signal);
      if (signal?.aborted) return;
      setLoadedAt(Date.now());
      if (result.status === "error" && showingGood.current) {
        // Only the first load shows "Couldn't reach Amber": after that, the last good copy stays.
        setStaleNote(true);
        return;
      }
      setStaleNote(false);
      showingGood.current = result.status === "ok";
      if (result.status === "ok") {
        setCode((previous) => {
          const next = toRenderable(result.homepage.code);
          return previous === next ? previous : next;
        });
      }
      setState(result);
    },
    [origin],
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

  if (state.status === "loading") return <div className="pane-msg">Loading…</div>;

  if (state.status === "ok" && code) {
    const label = builtLabel(state.homepage.timestamp);
    return (
      <>
        <div className="today-strip">
          <span className="meta today-built">{label ?? "Built on your Mac"}</span>
          <button type="button" className="ghost-btn small" onClick={() => void load()}>
            Refresh
          </button>
        </div>
        {staleNote && (
          <p className="meta today-note" role="status">
            Couldn’t refresh — showing the last copy
          </p>
        )}
        <div className="today-frame">
          <HomepagePreview code={code} />
        </div>
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
