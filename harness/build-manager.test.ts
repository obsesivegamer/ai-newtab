import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import type { runHomepageBuild } from "@homepage/agent-core";
import { BuildManager } from "../apps/extension/lib/build-manager";
import { REBUILD_POLL_MIN_MS } from "../apps/extension/lib/rebuild-request";
import { KEYS } from "../apps/extension/lib/storage";

const READER = "https://dell-plx-reader.tailf9612a.ts.net";
const PASSWORD = "s3cret-reader";
const START = Date.parse("2026-10-29T15:00:00.000Z");

const store = new Map<string, unknown>();
let notifications: string[] = [];
let readerCalls: Array<{ url: string; method: string }> = [];
let requestId = "req-1";
let restoreFetch: (() => void) | undefined;
const logs: string[] = [];
const restoreConsole: Array<() => void> = [];

const mockBrowser = {
  storage: {
    local: {
      async get(keys?: string | string[] | null): Promise<Record<string, unknown>> {
        const names = keys == null ? [...store.keys()] : typeof keys === "string" ? [keys] : keys;
        const out: Record<string, unknown> = {};
        for (const name of names) if (store.has(name)) out[name] = store.get(name);
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
  runtime: {
    async getPlatformInfo() {
      return {};
    },
    getURL: (path: string) => `chrome-extension://test${path}`,
  },
  notifications: {
    create(_options: { message: string }) {
      notifications.push(_options.message);
    },
  },
  history: {
    async search(): Promise<unknown[]> {
      return [];
    },
  },
};

beforeEach(() => {
  store.clear();
  notifications = [];
  readerCalls = [];
  requestId = "req-1";
  logs.length = 0;
  setSystemTime(new Date(START));
  (globalThis as unknown as { browser: typeof mockBrowser }).browser = mockBrowser;
  // No Mac archive. A reader with a password. Auto-rebuild on, but no homepage yet, so
  // the schedule never fires and the phone request is the only reason to build.
  store.set(KEYS.apiKey, "sk-test");
  store.set(KEYS.archiveUrl, "");
  store.set(KEYS.fallbackArchiveUrl, READER);
  store.set(KEYS.fallbackArchiveMigrated, 2);
  store.set(KEYS.readerPassword, PASSWORD);
  store.set(KEYS.sources, []);
  store.set(KEYS.sourcesMigrated, 1);

  const previous = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    readerCalls.push({ url, method: init?.method ?? "GET" });
    if (url === `${READER}/api/homepage/rebuild-request`) {
      return new Response(
        JSON.stringify({ requested_at: "2026-10-29T14:59:00.000Z", id: requestId, fulfilled_at: null }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  restoreFetch = () => {
    globalThis.fetch = previous;
  };
  for (const name of ["log", "warn", "error"] as const) {
    const original = console[name];
    console[name] = (...args: unknown[]) => {
      logs.push(args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(" "));
    };
    restoreConsole.push(() => {
      console[name] = original;
    });
  }
});

afterEach(() => {
  restoreFetch?.();
  restoreFetch = undefined;
  for (const undo of restoreConsole.splice(0)) undo();
  setSystemTime();
  delete (globalThis as { browser?: unknown }).browser;
});

async function settled(manager: BuildManager): Promise<void> {
  const inner = manager as unknown as { building: boolean; running: boolean };
  for (let i = 0; i < 200; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (!inner.building && !inner.running) return;
  }
  throw new Error("the build never finished");
}

/** One alarm minute: advance the clock past the poll gate, tick, and wait for any build to end. */
async function minute(manager: BuildManager, n: number): Promise<void> {
  setSystemTime(new Date(START + n * (REBUILD_POLL_MIN_MS + 10_000)));
  await manager.tick();
  await settled(manager);
}

function stub(behavior: () => Promise<{ code: string; source: string }>) {
  let calls = 0;
  const run = (async () => {
    calls += 1;
    return behavior();
  }) as unknown as typeof runHomepageBuild;
  return { run, count: () => calls };
}

test("a build that keeps failing is started at most twice for one phone request", async () => {
  const build = stub(async () => {
    throw new Error("Overloaded");
  });
  const manager = new BuildManager(build.run);
  for (let n = 1; n <= 8; n++) await minute(manager, n);

  // The first failure puts the id back once. The second one leaves it handled, the way
  // the scheduled path never retries a failure.
  expect(build.count()).toBe(2);
  expect(notifications).toHaveLength(2);
  expect(store.get(KEYS.handledRebuildRequestIds)).toEqual(["req-1"]);
  expect(store.get(KEYS.retriedRebuildRequestIds)).toEqual(["req-1"]);

  // A new tap is a new id and gets its own two tries.
  requestId = "req-2";
  for (let n = 9; n <= 16; n++) await minute(manager, n);
  expect(build.count()).toBe(4);
  expect(logs.join("\n").includes(PASSWORD)).toBe(false);
});

test("a failure followed by a success is built twice, then left alone", async () => {
  let attempt = 0;
  const build = stub(async () => {
    attempt += 1;
    if (attempt === 1) throw new Error("Overloaded");
    return { code: "export default function App(){return null}", source: "model" };
  });
  const manager = new BuildManager(build.run);
  for (let n = 1; n <= 6; n++) await minute(manager, n);
  expect(build.count()).toBe(2);
  expect(notifications).toHaveLength(1);
  expect(store.get(KEYS.handledRebuildRequestIds)).toEqual(["req-1"]);
});

test("a build that succeeds the first time is not repeated for the same request", async () => {
  const build = stub(async () => ({ code: "export default function App(){return null}", source: "model" }));
  const manager = new BuildManager(build.run);
  for (let n = 1; n <= 4; n++) await minute(manager, n);
  expect(build.count()).toBe(1);
  expect(notifications).toHaveLength(0);
});
