import { afterEach, expect, test } from "bun:test";
import { KEYS } from "../apps/extension/lib/storage";
import { adoptRemoteSources, flushSourcePush, saveAndPushSources } from "../apps/web/src/sync";

const ORIGIN = "http://127.0.0.1:8080";

const store = new Map<string, unknown>();
const original = { id: "nyt", name: "NYT", feedUrls: ["https://example.com/rss"], enabled: true };
const edited = { ...original, enabled: false };

const mockBrowser = {
  storage: {
    local: {
      async get(keys?: string | string[] | null): Promise<Record<string, unknown>> {
        const names = keys == null ? [...store.keys()] : typeof keys === "string" ? [keys] : keys;
        const out: Record<string, unknown> = {};
        for (const name of names) {
          if (store.has(name)) out[name] = store.get(name);
        }
        return out;
      },
      async set(items: Record<string, unknown>): Promise<void> {
        for (const [key, value] of Object.entries(items)) store.set(key, value);
      },
      async remove(keys: string | string[]): Promise<void> {
        for (const key of typeof keys === "string" ? [keys] : keys) store.delete(key);
      },
    },
  },
  history: {
    async search(): Promise<unknown[]> {
      return [];
    },
  },
};

let restoreFetch: (() => void) | undefined;

afterEach(() => {
  restoreFetch?.();
  restoreFetch = undefined;
  store.clear();
  delete (globalThis as { browser?: unknown }).browser;
});

test("a refused sources edit is put back when the first read timed out", async () => {
  store.set(KEYS.sources, [original]);
  store.set(KEYS.sourcesMigrated, 1);
  (globalThis as unknown as { browser: typeof mockBrowser }).browser = mockBrowser;
  const previous = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    if ((init?.method ?? "GET") === "GET") throw new TypeError("timed out");
    return new Response("", { status: 405 });
  }) as typeof fetch;
  restoreFetch = () => {
    globalThis.fetch = previous;
  };

  expect(await adoptRemoteSources(ORIGIN)).toBe(false);
  await saveAndPushSources(ORIGIN, [edited]);
  expect(store.get(KEYS.sources)).toEqual([edited]);

  flushSourcePush();
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(store.get(KEYS.sources)).toEqual([original]);
});
