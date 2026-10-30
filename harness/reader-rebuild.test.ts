import { afterEach, expect, test } from "bun:test";
import { READER_BASIC_USER, basicAuthorization } from "../apps/extension/lib/archive-auth";
import { publishBuiltHomepage, pushReaderHomepage } from "../apps/extension/lib/phone-sync";
import { fetchHomepage, fetchRemoteSources, publishSources, pushHomepage, rebuildRequestError, requestHomepageRebuild } from "../apps/extension/lib/phone-sync";
import { KEYS } from "../apps/extension/lib/storage";
import {
  READER_AUTH_MESSAGE,
  REBUILD_POLL_MIN_MS,
  REBUILD_POLL_TIMEOUT_MS,
  fetchRebuildRequest,
  passwordFingerprint,
  canPollRebuildRequest,
  forgetRebuildRequestId,
  persistedReaderAuthNotice,
  readerAuthNotice,
  rebuildTickAction,
  rememberRebuildRequestId,
  type RebuildRequest,
  type RebuildRequestFetch,
} from "../apps/extension/lib/rebuild-request";

const MAC = "http://127.0.0.1:8080";
const READER = "https://dell-plx-reader.tailf9612a.ts.net";
const PASSWORD = "s3cret-reader";
const BASIC = basicAuthorization(READER_BASIC_USER, PASSWORD);
const BUILT = "2026-10-28T15:00:00.000Z";
const REQUESTED = "2026-10-29T15:00:00.000Z";

interface Seen {
  url: string;
  method: string;
  authorization: string | null;
  redirect: RequestRedirect | undefined;
  contentType: string | null;
  body?: string;
}

let restore: (() => void) | undefined;
const warnings: string[] = [];
let restoreWarn: (() => void) | undefined;

afterEach(() => {
  restore?.();
  restore = undefined;
  restoreWarn?.();
  restoreWarn = undefined;
  warnings.length = 0;
});

function installFetch(handler: (url: string, init: RequestInit | undefined) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const previous = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    seen.push({
      url,
      method: init?.method ?? "GET",
      authorization: new Headers(init?.headers).get("authorization"),
      redirect: init?.redirect,
      contentType: new Headers(init?.headers).get("content-type"),
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    return handler(url, init);
  }) as typeof fetch;
  restore = () => {
    globalThis.fetch = previous;
  };
  return seen;
}

function watchWarnings() {
  const previous = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(" "));
  };
  restoreWarn = () => {
    console.warn = previous;
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const openRequest = (over: Partial<RebuildRequest> = {}): RebuildRequest => ({
  requestedAt: "2001-01-01T00:00:00.000Z",
  id: "req-1",
  fulfilledAt: null,
  baselineTimestamp: BUILT,
  expired: false,
  cooldown: false,
  ...over,
});

const ready = (over: Partial<RebuildRequest> = {}): RebuildRequestFetch => ({
  status: "ready",
  request: openRequest(over),
});

test("a rebuild starts once per unseen unfulfilled id, and never from the clocks", () => {
  const handled: string[] = [];
  expect(rebuildTickAction({ running: false, request: ready(), handledIds: handled })).toBe("start");
  // requested_at is years behind the last build. The id is what matters.
  expect(rebuildTickAction({ running: false, request: ready({ requestedAt: BUILT }), handledIds: handled })).toBe(
    "start",
  );
  const seen = rememberRebuildRequestId(handled, "req-1");
  expect(rebuildTickAction({ running: false, request: ready(), handledIds: seen })).toBe("skip");
  expect(rebuildTickAction({ running: false, request: ready({ fulfilledAt: REQUESTED }), handledIds: [] })).toBe("skip");
  expect(rebuildTickAction({ running: false, request: ready({ expired: true }), handledIds: [] })).toBe("skip");
  expect(rebuildTickAction({ running: false, request: ready({ cooldown: true }), handledIds: [] })).toBe("skip");
  expect(rebuildTickAction({ running: true, request: ready({ id: "req-2" }), handledIds: seen })).toBe("remember");
  expect(rememberRebuildRequestId(seen, "req-2")).toEqual(["req-1", "req-2"]);
  expect(forgetRebuildRequestId(["req-1", "req-2"], "req-1")).toEqual(["req-2"]);
  const many = Array.from({ length: 40 }, (_, i) => `id-${i}`);
  expect(rememberRebuildRequestId(many, "id-new")).toHaveLength(32);
  expect(rememberRebuildRequestId(many, "id-new").at(-1)).toBe("id-new");
});

test("a missing, failed, or rejected rebuild request does not start a build", () => {
  for (const request of [
    { status: "missing" },
    { status: "none" },
    { status: "error" },
    { status: "unauthorized" },
  ] as const) {
    expect(rebuildTickAction({ running: false, request, handledIds: [] })).toBe("skip");
  }
});

const poll = {
  readerConfigured: true,
  hasApiKey: true,
  autoRebuild: true,
  authRejected: false,
};

test("the reader is polled about once a minute, and only with a key, auto-rebuild, and a good password", () => {
  expect(REBUILD_POLL_MIN_MS).toBe(50_000);
  expect(REBUILD_POLL_TIMEOUT_MS).toBeLessThanOrEqual(3_000);
  expect(canPollRebuildRequest(poll)).toBe(true);
  expect(canPollRebuildRequest({ ...poll, readerConfigured: false })).toBe(false);
  expect(canPollRebuildRequest({ ...poll, hasApiKey: false })).toBe(false);
  expect(canPollRebuildRequest({ ...poll, autoRebuild: false })).toBe(false);
  expect(canPollRebuildRequest({ ...poll, authRejected: true })).toBe(false);
});

test("a rejected password keeps its banner after the in-memory notice is gone", async () => {
  const fingerprint = await passwordFingerprint(PASSWORD);
  expect(persistedReaderAuthNotice(fingerprint, fingerprint, null)).toBe(READER_AUTH_MESSAGE);
  expect(persistedReaderAuthNotice(fingerprint, fingerprint, READER_AUTH_MESSAGE)).toBe(READER_AUTH_MESSAGE);
  expect(persistedReaderAuthNotice(fingerprint, "other", READER_AUTH_MESSAGE)).toBeNull();
  expect(persistedReaderAuthNotice(undefined, fingerprint, null)).toBeNull();
  expect(persistedReaderAuthNotice(undefined, fingerprint, "Something else")).toBe("Something else");
});

test("a wrong reader password is reported once and then left alone", async () => {
  watchWarnings();
  expect(readerAuthNotice(false)).toBe(READER_AUTH_MESSAGE);
  expect(readerAuthNotice(true)).toBeNull();
  expect(READER_AUTH_MESSAGE).not.toContain(PASSWORD);
  const same = await passwordFingerprint(PASSWORD);
  expect(await passwordFingerprint(PASSWORD)).toBe(same);
  expect(await passwordFingerprint(`${PASSWORD}-other`)).not.toBe(same);

  const seen = installFetch(() => json(401, { detail: "unauthorized" }));
  expect(await fetchRebuildRequest(READER, PASSWORD, MAC)).toEqual({ status: "unauthorized" });
  expect(seen).toHaveLength(1);
  expect(seen[0].authorization).toBe(BASIC);
  expect(seen[0].redirect).toBe("error");
  expect(warnings.join("\n")).not.toContain(PASSWORD);
});

test("a missing rebuild endpoint is a 404 and carries the reader password only to that host", async () => {
  const seen = installFetch(() => json(404, { detail: "not found" }));
  expect(await fetchRebuildRequest(READER, PASSWORD, MAC)).toEqual({ status: "missing" });
  expect(seen).toHaveLength(1);
  expect(seen[0].url).toBe(`${READER}/api/homepage/rebuild-request`);
  expect(seen[0].authorization).toBe(BASIC);
  expect(seen[0].redirect).toBe("error");
  expect(atob(seen[0].authorization!.slice("Basic ".length))).toBe(`${READER_BASIC_USER}:${PASSWORD}`);
});

test("a rebuild request to the Mac origin carries no reader password", async () => {
  const seen = installFetch(() => json(200, { requested_at: REQUESTED, id: "r1", fulfilled_at: null }));
  const same = await fetchRebuildRequest(MAC, PASSWORD, MAC);
  expect(same.status).toBe("ready");
  expect(seen).toHaveLength(1);
  expect(seen[0].url.startsWith(`${MAC}/api/homepage/rebuild-request`)).toBe(true);
  expect(seen[0].authorization).toBeNull();
  expect(seen[0].redirect).toBeUndefined();
});

test("a successful build PUTs the homepage to the reader without sending the password to the Mac", async () => {
  watchWarnings();
  const seen = installFetch((url) => {
    if (url.startsWith(READER)) return json(500, { detail: "nope" });
    return json(200, { ok: true });
  });
  const homepage = { code: "export default function App(){return null}", timestamp: REQUESTED };
  await publishBuiltHomepage(MAC, READER, PASSWORD, homepage);

  const mac = seen.find((call) => call.url.startsWith(MAC));
  const reader = seen.find((call) => call.url.startsWith(READER));
  expect(mac).toMatchObject({ method: "PUT", authorization: null, redirect: undefined });
  expect(reader).toMatchObject({ method: "PUT", authorization: BASIC, redirect: "error" });
  expect(mac?.url).toBe(`${MAC}/api/homepage`);
  expect(reader?.url).toBe(`${READER}/api/homepage`);
  expect(reader?.body).toContain(`"timestamp":"${REQUESTED}"`);
  expect(warnings.join("\n")).not.toContain(PASSWORD);
  expect(warnings.join("\n")).toContain("reader answered 500");

  seen.length = 0;
  await pushReaderHomepage("https://example.com", PASSWORD, homepage, MAC);
  expect(seen).toHaveLength(0);
  expect(warnings.join("\n")).not.toContain(PASSWORD);
});

test("a phone rebuild POST sends JSON and keeps cooldown and expiry", async () => {
  const seen = installFetch(() =>
    json(200, {
      requested_at: REQUESTED,
      id: "req-9",
      fulfilled_at: REQUESTED,
      baseline_timestamp: BUILT,
      cooldown: true,
    }),
  );
  expect(await requestHomepageRebuild(READER)).toEqual({
    status: "ok",
    request: {
      requestedAt: REQUESTED,
      id: "req-9",
      fulfilledAt: REQUESTED,
      baselineTimestamp: BUILT,
      expired: false,
      cooldown: true,
    },
  });
  expect(seen[0]).toMatchObject({
    method: "POST",
    contentType: "application/json",
    body: "{}",
    authorization: null,
  });
});

test("a failed rebuild POST names the status, and silence says the reader didn't answer", async () => {
  installFetch(() => json(500, { detail: "nope" }));
  expect(await requestHomepageRebuild(READER)).toEqual({ status: "error", message: rebuildRequestError(500) });
  restore?.();
  installFetch(() => json(415, { detail: "type" }));
  expect(await requestHomepageRebuild(READER)).toEqual({ status: "error", message: rebuildRequestError(415) });
  restore?.();
  installFetch(() => {
    throw new TypeError("offline");
  });
  expect(await requestHomepageRebuild(READER)).toEqual({ status: "error", message: rebuildRequestError() });
  expect(rebuildRequestError()).not.toContain(PASSWORD);
  expect(rebuildRequestError(500)).toContain("500");
});

test("GET /api/homepage keeps rebuild_request so expired can be read from a GET", async () => {
  installFetch(() =>
    json(200, {
      code: "export default function App(){return null}",
      timestamp: BUILT,
      rebuild_request: { requested_at: REQUESTED, id: "req-9", fulfilled_at: null, expired: true },
    }),
  );
  const result = await fetchHomepage(READER);
  expect(result).toMatchObject({
    status: "ok",
    homepage: { rebuildRequest: { id: "req-9", expired: true, fulfilledAt: null } },
  });
});

test("the reader marks sources read-only, and a 405 is the same", async () => {
  installFetch(() =>
    json(200, {
      sources: [{ id: "nyt", name: "NYT", feedUrls: ["https://example.com/rss"], enabled: true }],
      updated_at: REQUESTED,
      read_only: true,
    }),
  );
  expect(await fetchRemoteSources(READER)).toMatchObject({ status: "list", readOnly: true, updatedAt: REQUESTED });
  restore?.();

  installFetch(() => json(405, { detail: "read only" }));
  expect(await fetchRemoteSources(READER)).toEqual({ status: "read_only" });
});

test("a 200 that is not a rebuild request is not reported as a status, and a bad address is not silence", async () => {
  installFetch(() => json(200, { ok: true }));
  expect(await requestHomepageRebuild(READER)).toEqual({ status: "error", message: rebuildRequestError(200) });
  expect(rebuildRequestError(200)).not.toContain("answered 200");
  // Any 2xx with no request in the body is the same unreadable-body case.
  restore?.();
  installFetch(() => json(201, { ok: true }));
  expect(await requestHomepageRebuild(READER)).toEqual({ status: "error", message: rebuildRequestError(201) });
  expect(rebuildRequestError(204)).toBe(rebuildRequestError(200));
  expect(rebuildRequestError()).toStartWith("Couldn't ask your Mac to rebuild.");
  expect(await requestHomepageRebuild("not a url")).toEqual({
    status: "error",
    message: "That isn't a reader address.",
  });
});

test("homepage, sources, and the homepage PUT send Basic only when the URL is the reader", async () => {
  const store = new Map<string, unknown>();
  store.set(KEYS.archiveUrl, MAC);
  store.set(KEYS.fallbackArchiveUrl, READER);
  store.set(KEYS.readerPassword, PASSWORD);
  store.set(KEYS.fallbackArchiveMigrated, 2);
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
  };
  (globalThis as unknown as { browser: typeof mockBrowser }).browser = mockBrowser;
  watchWarnings();
  const source = { id: "nyt", name: "NYT", feedUrls: ["https://example.com/rss"], enabled: true };
  const homepage = { code: "export default function App(){return null}", timestamp: BUILT };
  try {
    const seen = installFetch(() =>
      json(200, { code: homepage.code, timestamp: BUILT, sources: [source], updated_at: REQUESTED, count: 1 }),
    );
    await fetchHomepage(READER);
    await fetchRemoteSources(READER);
    await publishSources(READER, [source]);
    await pushHomepage(READER, homepage);
    for (const call of seen) {
      expect(call.url.startsWith(READER)).toBe(true);
      expect(call.authorization).toBe(BASIC);
      expect(call.redirect).toBe("error");
    }
    seen.length = 0;
    await fetchHomepage(MAC);
    await fetchRemoteSources(MAC);
    await publishSources(MAC, [source]);
    await pushHomepage(MAC, homepage);
    for (const call of seen) {
      expect(call.url.startsWith(MAC)).toBe(true);
      expect(call.authorization).toBeNull();
      expect(call.redirect).toBeUndefined();
    }
    store.set(KEYS.readerPassword, "");
    seen.length = 0;
    // A blank password means the reader is not called at all: it would answer 401 and
    // Chrome would put up its own login dialog.
    expect(await fetchHomepage(READER)).toMatchObject({ status: "error" });
    expect(await fetchRemoteSources(READER)).toEqual({ status: "unavailable" });
    expect(await publishSources(READER, [source])).toEqual({ status: "skipped" });
    await pushHomepage(READER, homepage);
    expect(seen).toHaveLength(0);
    // The Mac origin never needed the password.
    await fetchHomepage(MAC);
    await fetchRemoteSources(MAC);
    expect(seen).toHaveLength(2);
    expect(seen.every((call) => call.url.startsWith(MAC))).toBe(true);
    expect(seen.every((call) => call.authorization === null && call.redirect === undefined)).toBe(true);
    // Whitespace is blank too.
    store.set(KEYS.readerPassword, "   ");
    seen.length = 0;
    await fetchHomepage(READER);
    expect(seen).toHaveLength(0);
    expect(warnings.join("\n").includes(PASSWORD)).toBe(false);
    expect(/authorization/i.test(warnings.join("\n"))).toBe(false);
  } finally {
    delete (globalThis as { browser?: unknown }).browser;
  }
});
