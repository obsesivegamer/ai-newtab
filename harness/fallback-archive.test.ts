import { afterEach, expect, test } from "bun:test";
import {
  DEFAULT_FALLBACK_ARCHIVE_URL,
  RETIRED_FALLBACK_ARCHIVE_URL,
  migrateFallbackArchiveUrl,
} from "../apps/extension/lib/archive-auth";
import { KEYS, loadSettings } from "../apps/extension/lib/storage";

const store = new Map<string, unknown>();
let writes = 0;

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
        writes += 1;
        for (const [key, value] of Object.entries(items)) store.set(key, value);
      },
      async remove(keys: string | string[]): Promise<void> {
        for (const key of typeof keys === "string" ? [keys] : keys) store.delete(key);
      },
    },
  },
};

afterEach(() => {
  store.clear();
  writes = 0;
  delete (globalThis as { browser?: unknown }).browser;
});

test("the offline reader defaults to dell-plx", () => {
  expect(DEFAULT_FALLBACK_ARCHIVE_URL).toBe("http://dell-plx:8081");
  expect(RETIRED_FALLBACK_ARCHIVE_URL).toBe("http://boxj:8081");
});

test("a stored boxj default migrates to dell-plx and any other fallback stays", async () => {
  expect(migrateFallbackArchiveUrl(undefined)).toEqual({ url: DEFAULT_FALLBACK_ARCHIVE_URL, changed: false });
  expect(migrateFallbackArchiveUrl("")).toEqual({ url: "", changed: false });
  expect(migrateFallbackArchiveUrl("http://archive.example:9090")).toEqual({
    url: "http://archive.example:9090",
    changed: false,
  });
  expect(migrateFallbackArchiveUrl("http://boxj:8081/")).toEqual({ url: "http://boxj:8081/", changed: false });
  expect(migrateFallbackArchiveUrl(RETIRED_FALLBACK_ARCHIVE_URL)).toEqual({
    url: DEFAULT_FALLBACK_ARCHIVE_URL,
    changed: true,
  });

  (globalThis as unknown as { browser: typeof mockBrowser }).browser = mockBrowser;

  store.set(KEYS.fallbackArchiveUrl, RETIRED_FALLBACK_ARCHIVE_URL);
  const migrated = await loadSettings();
  expect(migrated.fallbackArchiveUrl).toBe("http://dell-plx:8081");
  expect(store.get(KEYS.fallbackArchiveUrl)).toBe("http://dell-plx:8081");
  expect(writes).toBe(1);

  writes = 0;
  const again = await loadSettings();
  expect(again.fallbackArchiveUrl).toBe("http://dell-plx:8081");
  expect(writes).toBe(0);

  store.set(KEYS.fallbackArchiveUrl, "http://archive.example:9090");
  const custom = await loadSettings();
  expect(custom.fallbackArchiveUrl).toBe("http://archive.example:9090");
  expect(store.get(KEYS.fallbackArchiveUrl)).toBe("http://archive.example:9090");
  expect(writes).toBe(0);

  store.set(KEYS.fallbackArchiveUrl, "");
  const off = await loadSettings();
  expect(off.fallbackArchiveUrl).toBe("");
  expect(writes).toBe(0);

  store.delete(KEYS.fallbackArchiveUrl);
  const fresh = await loadSettings();
  expect(fresh.fallbackArchiveUrl).toBe("http://dell-plx:8081");
  expect(store.has(KEYS.fallbackArchiveUrl)).toBe(false);
  expect(writes).toBe(0);
});
