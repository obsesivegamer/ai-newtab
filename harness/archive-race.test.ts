import { afterEach, beforeEach, expect, jest, test } from "bun:test";

// The reading helpers touch `browser.storage` only for the shared cache. The
// harness has no WebExtension types; this is enough for those calls to typecheck.
declare global {
  const browser: {
    storage: {
      local: {
        get(keys?: string | string[] | null): Promise<Record<string, unknown>>;
        set(items: Record<string, unknown>): Promise<void>;
        remove(keys: string | string[]): Promise<void>;
      };
    };
  };
}
import { LIST_TIMEOUT_MS, TEXT_TIMEOUT_MS, parseSnapshotList } from "../apps/extension/lib/archive";
import { READER_BASIC_USER, basicAuthorization } from "../apps/extension/lib/archive-auth";
import { loadReadingArticles, loadReadingList } from "../apps/extension/lib/archive-reading";
import {
  FALLBACK_DELAY_MS,
  MAC_DOWN_MS,
  MAC_UP_MS,
  createOriginCache,
  raceArchiveJson,
  type OriginCache,
} from "../apps/extension/lib/archive-race";

const MAC = "http://127.0.0.1:8080";
const BOX = "http://dell-plx:8081";
const PASSWORD = "secret";
const BASIC = basicAuthorization(READER_BASIC_USER, PASSWORD);
const LIST_PATH = "/api/snapshots?since_days=1&limit=1";

interface Call {
  url: string;
  authorization: string | null;
  redirect: RequestRedirect | undefined;
  signal: AbortSignal | undefined;
}

let restore: (() => void) | undefined;

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  restore?.();
  restore = undefined;
  jest.clearAllTimers();
  jest.useRealTimers();
});

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function listBody(title: string) {
  return {
    total_usable: 1,
    sources: [{ site: "Example", count: 1, latest: "2026-10-28T00:00:00Z" }],
    snapshots: [
      {
        id: "Ab12Cd",
        url: "https://example.com/a",
        final_url: "https://example.com/a",
        title,
        site: "Example",
        author: null,
        published_at: null,
        created_at: "2026-10-28T00:00:00Z",
        word_count: 400,
        paywalled: false,
      },
    ],
  };
}

function textBody(title: string) {
  return { ...listBody(title).snapshots[0], text: "The full story." };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** A body that arrives only when `release` resolves. Headers are already done. */
function heldBody(status = 200): { response: Response; release: (body: unknown) => void } {
  const gate = deferred<unknown>();
  const response = {
    ok: status >= 200 && status < 300,
    status,
    json: () => gate.promise,
  } as Response;
  return { response, release: gate.resolve };
}

function hang(signal: AbortSignal | null | undefined): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const fail = () => reject(new DOMException("The operation was aborted.", "AbortError"));
    if (!signal) return;
    if (signal.aborted) fail();
    else signal.addEventListener("abort", fail, { once: true });
  });
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

function install(handler: (url: string, init: RequestInit | undefined) => Promise<Response> | Response): Call[] {
  const calls: Call[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = urlOf(input);
    calls.push({
      url,
      authorization: new Headers(init?.headers).get("authorization"),
      redirect: init?.redirect,
      signal: init?.signal ?? undefined,
    });
    return handler(url, init);
  }) as typeof fetch;
  const previous = globalThis.fetch;
  globalThis.fetch = impl;
  restore = () => {
    globalThis.fetch = previous;
  };
  return calls;
}

function race(cache: OriginCache, fetchImpl: typeof fetch, path = LIST_PATH, signal?: AbortSignal) {
  return raceArchiveJson({
    macBase: MAC,
    fallbackBase: BOX,
    password: PASSWORD,
    path,
    timeoutMs: LIST_TIMEOUT_MS,
    cache,
    fetchImpl,
    signal,
  });
}

test("the Mac limits stay 10s for a list and 20s for text", () => {
  expect(LIST_TIMEOUT_MS).toBe(10_000);
  expect(TEXT_TIMEOUT_MS).toBe(20_000);
  expect(MAC_UP_MS).toBe(2 * 60 * 1000);
  expect(MAC_DOWN_MS).toBe(5 * 60 * 1000);
  expect(FALLBACK_DELAY_MS).toBe(1_500);
});

test("a fast Mac wins and dell-plx is never called", async () => {
  const calls = install(() => jsonResponse(listBody("From mac")));
  const cache = createOriginCache();

  const result = await race(cache, globalThis.fetch);
  expect(result.origin).toBe("mac");
  expect(result.base).toBe(MAC);
  expect(parseSnapshotList(result.base, result.json)?.articles[0]?.permalink).toBe(`${MAC}/Ab12Cd`);
  expect(calls.map((call) => call.url)).toEqual([`${MAC}${LIST_PATH}`]);
  expect(calls[0]?.authorization).toBeNull();
  expect(cache.upUntil).toBe(Date.now() + MAC_UP_MS);
  expect(cache.downUntil).toBeNull();

  jest.advanceTimersByTime(FALLBACK_DELAY_MS + LIST_TIMEOUT_MS);
  await flush();
  expect(calls).toHaveLength(1);

  const again = await race(cache, globalThis.fetch);
  jest.advanceTimersByTime(FALLBACK_DELAY_MS);
  await flush();
  expect(again.origin).toBe("mac");
  expect(calls).toHaveLength(2);
  expect(calls.every((call) => call.url.startsWith(MAC) && call.authorization === null)).toBe(true);
});

test("a hung Mac starts dell-plx at 1.5s and dell-plx's JSON wins", async () => {
  const calls = install((url, init) => {
    if (url.startsWith(MAC)) return hang(init?.signal ?? undefined);
    return jsonResponse(listBody("From dell-plx"));
  });
  const cache = createOriginCache();
  let settled = false;
  const pending = race(cache, globalThis.fetch).then((result) => {
    settled = true;
    return result;
  });

  await flush();
  expect(calls.map((call) => call.url)).toEqual([`${MAC}${LIST_PATH}`]);
  expect(calls[0]?.authorization).toBeNull();
  expect(settled).toBe(false);

  jest.advanceTimersByTime(FALLBACK_DELAY_MS - 1);
  await flush();
  expect(calls).toHaveLength(1);
  expect(settled).toBe(false);

  jest.advanceTimersByTime(1);
  const result = await pending;
  expect(result.origin).toBe("fallback");
  expect(result.base).toBe(BOX);
  expect(parseSnapshotList(result.base, result.json)?.articles[0]).toMatchObject({
    title: "From dell-plx",
    permalink: `${BOX}/Ab12Cd`,
  });
  expect(calls).toHaveLength(2);
  expect(calls[1]?.url).toBe(`${BOX}${LIST_PATH}`);
  expect(calls[1]?.authorization).toBe(BASIC);
  expect(atob(BASIC.slice("Basic ".length))).toBe(`${READER_BASIC_USER}:${PASSWORD}`);
  // The Mac request stays open so a late answer can still refresh the cache.
  expect(cache.upUntil).toBeNull();
  expect(cache.downUntil).toBeNull();

  jest.advanceTimersByTime(LIST_TIMEOUT_MS - FALLBACK_DELAY_MS);
  await flush();
  expect(cache.downUntil).toBe(Date.now() + MAC_DOWN_MS);
  expect(result.origin).toBe("fallback");
});

test("Mac response headers inside 1.5s keep dell-plx from starting", async () => {
  const held = heldBody();
  const calls = install((url) => {
    if (url.startsWith(BOX)) return jsonResponse(listBody("From dell-plx"));
    return held.response;
  });
  const cache = createOriginCache();
  const pending = race(cache, globalThis.fetch);

  await flush();
  jest.advanceTimersByTime(FALLBACK_DELAY_MS + 1_000);
  await flush();
  expect(calls.map((call) => call.url)).toEqual([`${MAC}${LIST_PATH}`]);

  held.release(listBody("From mac"));
  const result = await pending;
  expect(result.origin).toBe("mac");
  expect(calls).toHaveLength(1);
  expect(cache.upUntil).toBe(Date.now() + MAC_UP_MS);
});

test("a Mac body that never arrives fails over when the Mac limit expires", async () => {
  const held = heldBody();
  const calls = install((url) => {
    if (url.startsWith(BOX)) return jsonResponse(listBody("From dell-plx"));
    return held.response;
  });
  const cache = createOriginCache();
  const pending = race(cache, globalThis.fetch);

  await flush();
  jest.advanceTimersByTime(FALLBACK_DELAY_MS);
  await flush();
  expect(calls).toHaveLength(1);

  jest.advanceTimersByTime(LIST_TIMEOUT_MS - FALLBACK_DELAY_MS);
  const result = await pending;
  expect(result.origin).toBe("fallback");
  expect(result.base).toBe(BOX);
  expect(calls.map((call) => call.url)).toEqual([`${MAC}${LIST_PATH}`, `${BOX}${LIST_PATH}`]);
  expect(calls[1]?.authorization).toBe(BASIC);
  expect(cache.downUntil).toBe(Date.now() + MAC_DOWN_MS);
  expect(cache.upUntil).toBeNull();
});

test("a Mac 401 is the answer and dell-plx is not called", async () => {
  const calls = install((url) => {
    if (url.startsWith(BOX)) return jsonResponse(listBody("From dell-plx"));
    return new Response("no", { status: 401 });
  });
  const cache = createOriginCache();

  await expect(race(cache, globalThis.fetch)).rejects.toThrow(/responded 401/);
  jest.advanceTimersByTime(LIST_TIMEOUT_MS);
  await flush();
  expect(calls.map((call) => call.url)).toEqual([`${MAC}${LIST_PATH}`]);
  expect(calls[0]?.authorization).toBeNull();
  expect(cache.upUntil).toBeNull();
  expect(cache.downUntil).toBeNull();
});

test("a Mac 404 is the answer and dell-plx is not called", async () => {
  const calls = install(() => new Response("missing", { status: 404 }));
  const cache = createOriginCache();

  await expect(race(cache, globalThis.fetch)).rejects.toThrow(/responded 404/);
  jest.advanceTimersByTime(LIST_TIMEOUT_MS);
  await flush();
  expect(calls).toHaveLength(1);
  expect(calls[0]?.url.startsWith(MAC)).toBe(true);
  expect(cache.downUntil).toBeNull();
});

test("a Mac 401 aborts dell-plx when the fallback already started", async () => {
  const mac = deferred<Response>();
  let boxAborted = false;
  const calls = install((url, init) => {
    if (url.startsWith(MAC)) return mac.promise;
    const signal = init?.signal ?? undefined;
    signal?.addEventListener("abort", () => {
      boxAborted = true;
    });
    return hang(signal);
  });
  const cache = createOriginCache();
  const pending = race(cache, globalThis.fetch);

  await flush();
  jest.advanceTimersByTime(FALLBACK_DELAY_MS);
  await flush();
  expect(calls.map((call) => new URL(call.url).origin)).toEqual([new URL(MAC).origin, new URL(BOX).origin]);

  mac.resolve(new Response("no", { status: 401 }));
  await expect(pending).rejects.toThrow(/responded 401/);
  expect(boxAborted).toBe(true);
  expect(cache.upUntil).toBeNull();
  expect(cache.downUntil).toBeNull();
});

test("a cached Mac-down window calls only dell-plx", async () => {
  const calls = install((url) => {
    if (url.startsWith(MAC)) return jsonResponse(listBody("From mac"));
    return jsonResponse(listBody("From dell-plx"));
  });
  const cache = createOriginCache();
  cache.downUntil = Date.now() + MAC_DOWN_MS;

  const result = await race(cache, globalThis.fetch);
  jest.advanceTimersByTime(LIST_TIMEOUT_MS);
  await flush();
  expect(result.origin).toBe("fallback");
  expect(result.base).toBe(BOX);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.url).toBe(`${BOX}${LIST_PATH}`);
  expect(calls[0]?.authorization).toBe(BASIC);
});

test("a Mac network error fails over without waiting out 1.5s", async () => {
  const calls = install((url) => {
    if (url.startsWith(MAC)) return Promise.reject(new TypeError("connection refused"));
    return jsonResponse(listBody("From dell-plx"));
  });
  const cache = createOriginCache();

  const result = await race(cache, globalThis.fetch);
  expect(result.origin).toBe("fallback");
  expect(calls.map((call) => call.url)).toEqual([`${MAC}${LIST_PATH}`, `${BOX}${LIST_PATH}`]);
  expect(calls[0]?.authorization).toBeNull();
  expect(calls[1]?.authorization).toBe(BASIC);
  expect(cache.downUntil).toBe(Date.now() + MAC_DOWN_MS);
});

test("a late Mac answer refreshes the cache and leaves the list that already won", async () => {
  const mac = deferred<Response>();
  const calls = install((url, init) => {
    if (url.startsWith(MAC) && url.endsWith("/text")) return jsonResponse(textBody("From mac"));
    if (url.startsWith(MAC)) return mac.promise;
    if (url.endsWith("/text")) return jsonResponse(textBody("From dell-plx"));
    return jsonResponse(listBody("From dell-plx"));
  });
  const cache = createOriginCache();
  const pending = race(cache, globalThis.fetch);

  await flush();
  jest.advanceTimersByTime(FALLBACK_DELAY_MS);
  const result = await pending;
  const won = result.json;
  const shown = parseSnapshotList(result.base, result.json);
  expect(result.origin).toBe("fallback");
  expect(shown?.articles[0]).toMatchObject({ title: "From dell-plx", permalink: `${BOX}/Ab12Cd` });

  mac.resolve(jsonResponse(listBody("From mac")));
  await flush();
  expect(cache.upUntil).toBe(Date.now() + MAC_UP_MS);
  expect(cache.downUntil).toBeNull();
  expect(result.json).toBe(won);
  expect(result.origin).toBe("fallback");
  expect(result.base).toBe(BOX);
  expect(parseSnapshotList(result.base, result.json)?.articles[0]?.title).toBe("From dell-plx");
  expect(calls.filter((call) => call.url.startsWith(MAC)).every((call) => call.authorization === null)).toBe(true);
  expect(result.json).toBe(won);

  const beforeText = calls.length;
  const text = await loadReadingArticles({
    macBase: MAC,
    auth: { macBase: MAC, fallbackBase: BOX, password: PASSWORD },
    ids: ["Ab12Cd"],
    pinnedBase: result.base,
    cache,
  });
  expect(text.originBase).toBe(BOX);
  expect(text.articles[0]?.text).toBe("The full story.");
  expect(text.articles[0]?.permalink).toBe(`${BOX}/Ab12Cd`);
  const textCalls = calls.slice(beforeText);
  expect(textCalls.map((call) => call.url)).toEqual([`${BOX}/api/snapshots/Ab12Cd/text`]);
  expect(textCalls[0]?.authorization).toBe(BASIC);
  expect(cache.upUntil).toBe(Date.now() + MAC_UP_MS);
});

test("the list helper pins permalinks to the origin that won", async () => {
  const calls = install((url) => jsonResponse(url.endsWith("/text") ? textBody("From mac") : listBody("From mac")));
  const cache = createOriginCache();
  const auth = { macBase: MAC, fallbackBase: BOX, password: PASSWORD };

  const listed = await loadReadingList({
    macBase: MAC,
    sinceDays: 1,
    limit: 1,
    auth,
    cache,
    fetchImpl: globalThis.fetch,
  });
  expect(listed.originBase).toBe(MAC);
  expect(listed.articles[0]?.permalink).toBe(`${MAC}/Ab12Cd`);
  expect(calls.every((call) => call.authorization === null)).toBe(true);

  const text = await loadReadingArticles({
    macBase: MAC,
    auth,
    ids: ["Ab12Cd"],
    pinnedBase: listed.originBase,
    cache,
  });
  expect(text.articles[0]?.permalink).toBe(`${MAC}/Ab12Cd`);
  expect(calls.at(-1)?.url).toBe(`${MAC}/api/snapshots/Ab12Cd/text`);
  expect(calls.at(-1)?.authorization).toBeNull();
});

test("when the Mac wins, the fallback already in flight is aborted", async () => {
  const mac = deferred<Response>();
  let boxSignal: AbortSignal | undefined;
  const calls = install((url, init) => {
    if (url.startsWith(MAC)) return mac.promise;
    boxSignal = init?.signal ?? undefined;
    return hang(boxSignal);
  });
  const cache = createOriginCache();
  const pending = race(cache, globalThis.fetch);

  await flush();
  jest.advanceTimersByTime(FALLBACK_DELAY_MS);
  await flush();
  expect(boxSignal).toBeDefined();
  expect(boxSignal?.aborted).toBe(false);

  mac.resolve(jsonResponse(listBody("From mac")));
  const result = await pending;
  expect(result.origin).toBe("mac");
  expect(parseSnapshotList(result.base, result.json)?.articles[0]?.title).toBe("From mac");
  expect(boxSignal?.aborted).toBe(true);
  expect(calls[0]?.authorization).toBeNull();
  expect(calls[1]?.authorization).toBe(BASIC);
  expect(cache.upUntil).toBe(Date.now() + MAC_UP_MS);
});

test("aborting after the Mac failed rejects while dell-plx is still in flight", async () => {
  const caller = new AbortController();
  const calls = install((url, init) => {
    if (url.startsWith(MAC)) return Promise.reject(new TypeError("connection refused"));
    return hang(init?.signal);
  });
  const cache = createOriginCache();
  const pending = race(cache, globalThis.fetch, LIST_PATH, caller.signal);

  await flush();
  expect(calls.map((call) => new URL(call.url).origin)).toEqual([new URL(MAC).origin, new URL(BOX).origin]);
  caller.abort();
  await expect(pending).rejects.toThrow(/aborted/);
  await flush();
  // Settled by the cancel, not by dell-plx's own 10s limit.
  expect(jest.getTimerCount()).toBe(0);
});

test("a dell-plx request refuses redirects so the password cannot follow one", async () => {
  const calls = install((url) => {
    if (url.startsWith(MAC)) return Promise.reject(new TypeError("connection refused"));
    return jsonResponse(listBody("From dell-plx"));
  });
  const cache = createOriginCache();

  await race(cache, globalThis.fetch);
  expect(calls[0]).toMatchObject({ authorization: null, redirect: undefined });
  expect(calls[1]).toMatchObject({ authorization: BASIC, redirect: "error" });
});

test("a late Mac answer does not swap the list already returned", async () => {
  const mac = deferred<Response>();
  install((url) => {
    if (url.startsWith(MAC)) return mac.promise;
    return jsonResponse(listBody("From dell-plx"));
  });
  const cache = createOriginCache();
  const pending = loadReadingList({
    macBase: MAC,
    sinceDays: 1,
    limit: 1,
    auth: { macBase: MAC, fallbackBase: BOX, password: PASSWORD },
    cache,
    fetchImpl: globalThis.fetch,
  });

  await flush();
  jest.advanceTimersByTime(FALLBACK_DELAY_MS);
  const listed = await pending;
  const articles = listed.articles;
  expect(listed.originBase).toBe(BOX);
  expect(articles[0]?.title).toBe("From dell-plx");
  expect(articles[0]?.permalink).toBe(`${BOX}/Ab12Cd`);

  mac.resolve(jsonResponse(listBody("From mac")));
  await flush();
  expect(listed.articles).toBe(articles);
  expect(listed.originBase).toBe(BOX);
  expect(listed.articles[0]?.title).toBe("From dell-plx");
  expect(listed.articles[0]?.permalink).toBe(`${BOX}/Ab12Cd`);
  expect(cache.upUntil).toBe(Date.now() + MAC_UP_MS);
  expect(cache.downUntil).toBeNull();
});

test("the two-minute Mac-up window expires back into a cold race", async () => {
  let macHung = false;
  const calls = install((url, init) => {
    if (url.startsWith(MAC)) return macHung ? hang(init?.signal) : jsonResponse(listBody("From mac"));
    return jsonResponse(listBody("From dell-plx"));
  });
  const cache = createOriginCache();

  const first = await race(cache, globalThis.fetch);
  expect(first.origin).toBe("mac");
  expect(cache.upUntil).toBe(Date.now() + MAC_UP_MS);

  jest.advanceTimersByTime(MAC_UP_MS - 1);
  calls.length = 0;
  const during = await race(cache, globalThis.fetch);
  expect(during.origin).toBe("mac");
  expect(calls.map((call) => call.url)).toEqual([`${MAC}${LIST_PATH}`]);
  // A Mac win inside the window starts it over.
  expect(cache.upUntil).toBe(Date.now() + MAC_UP_MS);

  jest.advanceTimersByTime(MAC_UP_MS);
  macHung = true;
  calls.length = 0;
  let settled = false;
  const pending = race(cache, globalThis.fetch).then((result) => {
    settled = true;
    return result;
  });
  await flush();
  expect(settled).toBe(false);
  expect(calls.map((call) => call.url)).toEqual([`${MAC}${LIST_PATH}`]);
  jest.advanceTimersByTime(FALLBACK_DELAY_MS - 1);
  await flush();
  expect(calls).toHaveLength(1);
  expect(settled).toBe(false);
  jest.advanceTimersByTime(1);
  const after = await pending;
  expect(after.origin).toBe("fallback");
  expect(after.base).toBe(BOX);
  expect(calls[1]?.url).toBe(`${BOX}${LIST_PATH}`);
});

test("the five-minute Mac-down window expires back into a cold race", async () => {
  let macDown = true;
  const calls = install((url) => {
    if (url.startsWith(MAC)) {
      return macDown ? Promise.reject(new TypeError("connection refused")) : jsonResponse(listBody("From mac"));
    }
    return jsonResponse(listBody("From dell-plx"));
  });
  const cache = createOriginCache();

  const first = await race(cache, globalThis.fetch);
  expect(first.origin).toBe("fallback");
  const downUntil = cache.downUntil;
  expect(downUntil).toBe(Date.now() + MAC_DOWN_MS);

  jest.advanceTimersByTime(MAC_DOWN_MS - 1);
  calls.length = 0;
  const during = await race(cache, globalThis.fetch);
  expect(during.origin).toBe("fallback");
  expect(calls.map((call) => call.url)).toEqual([`${BOX}${LIST_PATH}`]);
  // A dell-plx read does not extend the window.
  expect(cache.downUntil).toBe(downUntil);

  jest.advanceTimersByTime(1);
  macDown = false;
  calls.length = 0;
  const after = await race(cache, globalThis.fetch);
  expect(after.origin).toBe("mac");
  expect(after.base).toBe(MAC);
  expect(calls.map((call) => call.url)).toEqual([`${MAC}${LIST_PATH}`]);
  expect(cache.upUntil).toBe(Date.now() + MAC_UP_MS);
  expect(cache.downUntil).toBeNull();
});
