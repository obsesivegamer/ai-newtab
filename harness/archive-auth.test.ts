import { afterEach, expect, test } from "bun:test";
import { createArchiveBridge } from "../apps/extension/lib/archive";
import { READER_BASIC_USER } from "../apps/extension/lib/archive-auth";

const MAC = "http://127.0.0.1:8080";
const BOX = "http://dell-plx:8081";
const PASSWORD = "secret";

interface Seen {
  url: string;
  authorization: string | null;
  redirect: RequestRedirect | undefined;
}

let restore: (() => void) | undefined;

afterEach(() => {
  restore?.();
  restore = undefined;
});

function listBody() {
  return {
    total_usable: 1,
    sources: [{ site: "Example", count: 1, latest: "2026-10-28T00:00:00Z" }],
    snapshots: [
      {
        id: "Ab12Cd",
        url: "https://example.com/a",
        final_url: "https://example.com/a",
        title: "A story",
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

function installFetch() {
  const seen: Seen[] = [];
  const previous = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    seen.push({
      url,
      authorization: new Headers(init?.headers).get("authorization"),
      redirect: init?.redirect,
    });
    return new Response(JSON.stringify(listBody()), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  restore = () => {
    globalThis.fetch = previous;
  };
  return seen;
}

test("a Mac archive request carries no Authorization header", async () => {
  const seen = installFetch();
  const auth = { macBase: MAC, fallbackBase: BOX, password: PASSWORD };

  await createArchiveBridge(MAC, auth).listArticles({ sinceDays: 1, limit: 1 });

  expect(seen).toHaveLength(1);
  expect(seen[0].url.startsWith(`${MAC}/api/snapshots`)).toBe(true);
  expect(seen[0].authorization).toBeNull();
  expect(seen[0].redirect).toBeUndefined();

  seen.length = 0;
  await createArchiveBridge(BOX, auth).listArticles({ sinceDays: 1, limit: 1 });
  expect(seen[0].url.startsWith(`${BOX}/api/snapshots`)).toBe(true);
  expect(seen[0].authorization?.startsWith("Basic ")).toBe(true);
  expect(atob(seen[0].authorization!.slice("Basic ".length))).toBe(`${READER_BASIC_USER}:${PASSWORD}`);
  expect(seen[0].redirect).toBe("error");

  // The Mac origin wins even if someone points both addresses at it.
  seen.length = 0;
  await createArchiveBridge(BOX, { macBase: BOX, fallbackBase: BOX, password: PASSWORD }).listArticles({
    sinceDays: 1,
    limit: 1,
  });
  expect(seen[0].authorization).toBeNull();
  expect(seen[0].redirect).toBeUndefined();
});
