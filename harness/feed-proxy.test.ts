import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { installFeedProxy, proxiedUrl } from "../apps/web/src/feedProxy";

const ORIGIN = "http://dell-plx-reader:8081";

interface Seen {
  url: string;
  credentials: RequestCredentials | undefined;
}

const restores: Array<() => void> = [];

afterEach(() => {
  while (restores.length > 0) restores.pop()?.();
});

/**
 * `installFeedProxy` wraps the page's `window.fetch` and reads `location`.
 * Stand the page up on the offline reader so the assertions are about that origin.
 */
function installPage(): { seen: Seen[] } {
  const win = new Window({ url: `${ORIGIN}/app/` });
  const seen: Seen[] = [];
  const previous = {
    window: globalThis.window,
    location: globalThis.location,
    fetch: globalThis.fetch,
  };
  win.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    seen.push({ url, credentials: init?.credentials });
    return new win.Response("<rss></rss>", { status: 200 });
  }) as unknown as typeof win.fetch;
  globalThis.window = win as unknown as Window & typeof globalThis.window;
  globalThis.location = win.location as unknown as Location;
  globalThis.fetch = win.fetch as unknown as typeof fetch;
  restores.push(() => {
    globalThis.window = previous.window;
    globalThis.location = previous.location;
    globalThis.fetch = previous.fetch;
    win.close();
  });
  installFeedProxy();
  return { seen };
}

test("feed proxy stays on location.origin and sends the session cookie", async () => {
  const { seen } = installPage();
  const feed = "https://news.example/rss.xml";

  const response = await window.fetch(feed);
  expect(response.ok).toBe(true);
  expect(seen).toHaveLength(1);
  expect(seen[0].url).toBe(proxiedUrl(feed, ORIGIN));
  expect(new URL(seen[0].url).origin).toBe(ORIGIN);
  expect(seen[0].credentials).toBe("same-origin");

  seen.length = 0;
  await window.fetch(`${ORIGIN}/api/snapshots?since_days=1&limit=1`);
  expect(seen).toHaveLength(1);
  expect(new URL(seen[0].url).origin).toBe(ORIGIN);
  expect(seen[0].url).not.toContain("/api/feedproxy");
});
