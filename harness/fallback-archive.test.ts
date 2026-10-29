import { afterEach, expect, test } from "bun:test";
import {
  DEFAULT_FALLBACK_ARCHIVE_URL,
  FALLBACK_ARCHIVE_MIGRATION_VERSION,
  RETIRED_FALLBACK_ARCHIVE_URLS,
  migrateFallbackArchiveUrl,
} from "../apps/extension/lib/archive-auth";
import { KEYS, loadSettings } from "../apps/extension/lib/storage";

const READER = "http://dell-plx-reader:8081";
const RETIRED = "http://boxj:8081";
const INTERMEDIATE = "http://dell-plx:8081";

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

function installBrowser() {
  (globalThis as unknown as { browser: typeof mockBrowser }).browser = mockBrowser;
}

test("the offline reader defaults to dell-plx-reader", () => {
  expect(DEFAULT_FALLBACK_ARCHIVE_URL).toBe(READER);
  expect(RETIRED_FALLBACK_ARCHIVE_URLS).toEqual([RETIRED, INTERMEDIATE]);
  expect(FALLBACK_ARCHIVE_MIGRATION_VERSION).toBe(1);
});

test("retired defaults migrate once and every other fallback stays", () => {
  expect(migrateFallbackArchiveUrl(undefined, undefined)).toEqual({
    url: READER,
    changed: false,
    recordVersion: true,
  });
  expect(migrateFallbackArchiveUrl("", undefined)).toEqual({ url: "", changed: false, recordVersion: true });
  expect(migrateFallbackArchiveUrl("http://archive.example:9090", undefined)).toEqual({
    url: "http://archive.example:9090",
    changed: false,
    recordVersion: true,
  });
  expect(migrateFallbackArchiveUrl("https://boxj:8081", undefined)).toEqual({
    url: "https://boxj:8081",
    changed: false,
    recordVersion: true,
  });
  expect(migrateFallbackArchiveUrl("http://boxj:8081/", undefined)).toEqual({
    url: "http://boxj:8081/",
    changed: false,
    recordVersion: true,
  });
  expect(migrateFallbackArchiveUrl(RETIRED, undefined)).toEqual({ url: READER, changed: true, recordVersion: true });
  expect(migrateFallbackArchiveUrl(INTERMEDIATE, undefined)).toEqual({
    url: READER,
    changed: true,
    recordVersion: true,
  });
  expect(migrateFallbackArchiveUrl(RETIRED, FALLBACK_ARCHIVE_MIGRATION_VERSION)).toEqual({
    url: RETIRED,
    changed: false,
    recordVersion: false,
  });
  expect(migrateFallbackArchiveUrl(INTERMEDIATE, FALLBACK_ARCHIVE_MIGRATION_VERSION)).toEqual({
    url: INTERMEDIATE,
    changed: false,
    recordVersion: false,
  });
});

test("a stored retired default is rewritten once and the migration is recorded", async () => {
  installBrowser();

  for (const retired of [RETIRED, INTERMEDIATE]) {
    store.clear();
    writes = 0;
    store.set(KEYS.fallbackArchiveUrl, retired);
    const migrated = await loadSettings();
    expect(migrated.fallbackArchiveUrl).toBe(READER);
    expect(store.get(KEYS.fallbackArchiveUrl)).toBe(READER);
    expect(store.get(KEYS.fallbackArchiveMigrated)).toBe(FALLBACK_ARCHIVE_MIGRATION_VERSION);
    expect(writes).toBe(1);

    writes = 0;
    const again = await loadSettings();
    expect(again.fallbackArchiveUrl).toBe(READER);
    expect(writes).toBe(0);
  }
});

test("the migration flag keeps a later choice of a retired address", async () => {
  installBrowser();
  store.set(KEYS.fallbackArchiveUrl, "http://archive.example:9090");
  const custom = await loadSettings();
  expect(custom.fallbackArchiveUrl).toBe("http://archive.example:9090");
  expect(store.get(KEYS.fallbackArchiveUrl)).toBe("http://archive.example:9090");
  expect(store.get(KEYS.fallbackArchiveMigrated)).toBe(FALLBACK_ARCHIVE_MIGRATION_VERSION);
  expect(writes).toBe(1);

  for (const chosen of [RETIRED, INTERMEDIATE]) {
    writes = 0;
    store.set(KEYS.fallbackArchiveUrl, chosen);
    const kept = await loadSettings();
    expect(kept.fallbackArchiveUrl).toBe(chosen);
    expect(store.get(KEYS.fallbackArchiveUrl)).toBe(chosen);
    expect(writes).toBe(0);
  }
});

test("near-misses, an empty address, and a missing address are not rewritten", async () => {
  installBrowser();

  for (const kept of ["https://boxj:8081", "http://boxj:8081/", ""]) {
    store.clear();
    writes = 0;
    store.set(KEYS.fallbackArchiveUrl, kept);
    const loaded = await loadSettings();
    expect(loaded.fallbackArchiveUrl).toBe(kept);
    expect(store.get(KEYS.fallbackArchiveUrl)).toBe(kept);
    expect(store.get(KEYS.fallbackArchiveMigrated)).toBe(FALLBACK_ARCHIVE_MIGRATION_VERSION);
    expect(writes).toBe(1);

    writes = 0;
    store.set(KEYS.fallbackArchiveUrl, RETIRED);
    const later = await loadSettings();
    expect(later.fallbackArchiveUrl).toBe(RETIRED);
    expect(writes).toBe(0);
  }

  store.clear();
  writes = 0;
  const fresh = await loadSettings();
  expect(fresh.fallbackArchiveUrl).toBe(READER);
  expect(store.has(KEYS.fallbackArchiveUrl)).toBe(false);
  expect(store.get(KEYS.fallbackArchiveMigrated)).toBe(FALLBACK_ARCHIVE_MIGRATION_VERSION);
  expect(writes).toBe(1);
});
