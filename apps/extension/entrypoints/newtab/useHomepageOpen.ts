import { useCallback, useEffect, useRef } from "react";
import { isAllowedUrl } from "@homepage/agent-core";
import { entryFromId, entryFromUrl, type ReaderEntry } from "./readerEntry";

/** What the model-built homepage may ask the page to open. Anything else is ignored. */
export const OPEN_ARTICLE = "homepage:open-article";
export const ARTICLE_ID = /^[A-Za-z0-9]{3,16}$/;
/** The same, for a story that is not in the archive: only an address. */
export const OPEN_URL = "homepage:open-url";
export const MAX_OPEN_URL_LENGTH = 2048;
/** At most this many open requests are looked at per second; a page cannot spam the reader. */
export const MESSAGES_PER_SECOND = 3;

/**
 * The model-built homepage asks to open a story in the native reader: an archived one by
 * id, or one that is not in the archive by address. It can only ever open the in-page
 * reader; it never navigates this page, opens a window, or saves anything by itself.
 *
 * One gate for both messages, shared by the extension's new tab and the web app:
 * only the homepage's own Sandpack frame (an iframe inside `.today-frame`) may ask, only
 * while `canOpen` (the Today tab is showing and neither the Reader nor Settings covers it:
 * a hidden or covered frame can't have been clicked), bursts are dropped and an immediate
 * repeat is ignored. For open-url, `url` must be http(s) with no credentials, pass
 * `isAllowedUrl` against the blocked list, and is opened as the parsed `href`.
 *
 * Returns `reset`, to call when the Reader closes: closing is the person's answer to the
 * last request, so asking again right away is a new click.
 */
export function useHomepageOpen({
  canOpen,
  blockedSites,
  onOpen,
}: {
  canOpen: boolean;
  blockedSites: string[];
  onOpen: (entry: ReaderEntry) => void;
}) {
  // The listener is installed once, so it reads what it needs through a ref.
  const latest = useRef({ canOpen, blockedSites, onOpen });
  latest.current = { canOpen, blockedSites, onOpen };
  /** The last open request let through, so an immediate repeat is dropped. */
  const lastOpen = useRef({ key: "", at: 0 });

  useEffect(() => {
    const fromHomepage = (source: MessageEventSource | null) => {
      // Only the homepage's own Sandpack frame may ask; the model's code runs in there.
      const frames = document.querySelectorAll<HTMLIFrameElement>(".today-frame iframe");
      return Array.from(frames).some((frame) => frame.contentWindow !== null && frame.contentWindow === source);
    };
    let recent: number[] = [];

    const onMessage = (e: MessageEvent) => {
      const data = e.data as { type?: unknown; id?: unknown; url?: unknown } | null;
      if (!data || typeof data !== "object" || Array.isArray(data)) return;
      if (data.type !== OPEN_ARTICLE && data.type !== OPEN_URL) return;

      if (!fromHomepage(e.source)) return;
      if (!latest.current.canOpen) return;
      const now = Date.now();
      recent = recent.filter((t) => now - t < 1000);
      if (recent.length >= MESSAGES_PER_SECOND) return;
      recent.push(now);

      if (data.type === OPEN_ARTICLE) {
        if (typeof data.id !== "string" || !ARTICLE_ID.test(data.id)) return;
        const id = data.id;
        const last = lastOpen.current;
        if (last.key === `a:${id}` && now - last.at < 2000) return;
        lastOpen.current = { key: `a:${id}`, at: now };
        latest.current.onOpen(entryFromId(id));
        return;
      }

      if (typeof data.url !== "string" || data.url.length === 0 || data.url.length > MAX_OPEN_URL_LENGTH) return;
      let parsed: URL;
      try {
        parsed = new URL(data.url);
      } catch {
        return;
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return;
      if (parsed.username || parsed.password) return;
      if (!isAllowedUrl(parsed.href, latest.current.blockedSites)) return;
      // The model's links arrive with `'` percent-encoded; the publisher's address has the apostrophe.
      const href = parsed.href.replace(/%27/gi, "'");
      const last = lastOpen.current;
      if (last.key === `u:${href}` && now - last.at < 2000) return;
      lastOpen.current = { key: `u:${href}`, at: now };
      latest.current.onOpen(entryFromUrl(href));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const reset = useCallback(() => {
    lastOpen.current = { key: "", at: 0 };
  }, []);
  return { reset };
}
