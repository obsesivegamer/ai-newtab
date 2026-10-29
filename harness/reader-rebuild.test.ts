import { afterEach, expect, test } from "bun:test";
import { READER_BASIC_USER, basicAuthorization } from "../apps/extension/lib/archive-auth";
import { publishBuiltHomepage, pushReaderHomepage } from "../apps/extension/lib/phone-sync";
import { fetchRemoteSources, requestHomepageRebuild } from "../apps/extension/lib/phone-sync";
import {
  READER_AUTH_MESSAGE,
  REBUILD_POLL_MIN_MS,
  REBUILD_POLL_TIMEOUT_MS,
  fetchRebuildRequest,
  passwordFingerprint,
  readerAuthNotice,
  rebuildTickAction,
  rememberRebuildRequestId,
  shouldPollRebuildRequest,
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
  running: false,
  now: 1_000_000,
  lastPollAt: 0,
  readerConfigured: true,
  hasApiKey: true,
  autoRebuild: true,
  authRejected: false,
};

test("the reader is polled about once a minute, and only with a key, auto-rebuild, and a good password", () => {
  expect(REBUILD_POLL_MIN_MS).toBe(60_000);
  expect(REBUILD_POLL_TIMEOUT_MS).toBeLessThanOrEqual(3_000);
  expect(shouldPollRebuildRequest({ ...poll, running: true })).toBe(false);
  expect(shouldPollRebuildRequest({ ...poll, readerConfigured: false })).toBe(false);
  expect(shouldPollRebuildRequest({ ...poll, hasApiKey: false })).toBe(false);
  expect(shouldPollRebuildRequest({ ...poll, autoRebuild: false })).toBe(false);
  expect(shouldPollRebuildRequest({ ...poll, authRejected: true })).toBe(false);
  expect(shouldPollRebuildRequest({ ...poll, lastPollAt: poll.now - REBUILD_POLL_MIN_MS + 1 })).toBe(false);
  expect(shouldPollRebuildRequest({ ...poll, lastPollAt: poll.now - REBUILD_POLL_MIN_MS })).toBe(true);
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
