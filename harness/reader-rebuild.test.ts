import { afterEach, expect, test } from "bun:test";
import { READER_BASIC_USER, basicAuthorization } from "../apps/extension/lib/archive-auth";
import { publishBuiltHomepage, pushReaderHomepage } from "../apps/extension/lib/phone-sync";
import {
  REBUILD_POLL_MIN_MS,
  fetchRebuildRequest,
  rebuildTickAction,
  shouldPollRebuildRequest,
  type RebuildRequestFetch,
} from "../apps/extension/lib/rebuild-request";

const MAC = "http://127.0.0.1:8080";
const READER = "https://dell-plx-reader.tailf9612a.ts.net";
const PASSWORD = "s3cret-reader";
const BASIC = basicAuthorization(READER_BASIC_USER, PASSWORD);
const BUILT = "2026-10-28T15:00:00.000Z";
const ATTEMPT = "2026-10-28T16:00:00.000Z";
const REQUESTED = "2026-10-29T15:00:00.000Z";

interface Seen {
  url: string;
  method: string;
  authorization: string | null;
  redirect: RequestRedirect | undefined;
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

const ready = (requestedAt = REQUESTED): RebuildRequestFetch => ({ status: "ready", requestedAt });

test("a newer rebuild request starts, and an older one does not", () => {
  expect(
    rebuildTickAction({
      running: false,
      request: ready(),
      lastBuildTimestamp: BUILT,
      lastAttemptTimestamp: ATTEMPT,
    }),
  ).toBe("start");
  // Newer than a failed attempt from a minute ago: the interval and the backoff do not apply.
  const recentAttempt = new Date(Date.parse(REQUESTED) - 60_000).toISOString();
  expect(
    rebuildTickAction({
      running: false,
      request: ready(),
      lastBuildTimestamp: BUILT,
      lastAttemptTimestamp: recentAttempt,
    }),
  ).toBe("start");
  expect(
    rebuildTickAction({
      running: false,
      request: ready(BUILT),
      lastBuildTimestamp: BUILT,
      lastAttemptTimestamp: null,
    }),
  ).toBe("skip");
  expect(
    rebuildTickAction({
      running: false,
      request: ready("2026-10-28T15:30:00.000Z"),
      lastBuildTimestamp: BUILT,
      lastAttemptTimestamp: ATTEMPT,
    }),
  ).toBe("skip");
});

test("a rebuild request does not start a second build or a missing endpoint", () => {
  expect(
    rebuildTickAction({
      running: true,
      request: ready(),
      lastBuildTimestamp: BUILT,
      lastAttemptTimestamp: ATTEMPT,
    }),
  ).toBe("skip");
  for (const request of [{ status: "missing" }, { status: "none" }, { status: "error" }] as const) {
    expect(
      rebuildTickAction({
        running: false,
        request,
        lastBuildTimestamp: BUILT,
        lastAttemptTimestamp: null,
      }),
    ).toBe("skip");
  }
});

test("the reader is polled about once a minute, and only when it is configured", () => {
  const now = 1_000_000;
  expect(shouldPollRebuildRequest({ running: true, now, lastPollAt: 0, readerConfigured: true })).toBe(false);
  expect(shouldPollRebuildRequest({ running: false, now, lastPollAt: 0, readerConfigured: false })).toBe(false);
  expect(
    shouldPollRebuildRequest({ running: false, now, lastPollAt: now - REBUILD_POLL_MIN_MS + 1, readerConfigured: true }),
  ).toBe(false);
  expect(
    shouldPollRebuildRequest({ running: false, now, lastPollAt: now - REBUILD_POLL_MIN_MS, readerConfigured: true }),
  ).toBe(true);
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
  expect(warnings.join("\n")).not.toContain(PASSWORD);
  expect(warnings.join("\n")).toContain("reader answered 500");

  seen.length = 0;
  await pushReaderHomepage("https://example.com", PASSWORD, homepage, MAC);
  expect(seen).toHaveLength(0);
  expect(warnings.join("\n")).not.toContain(PASSWORD);
});
