import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createArchiveBridge } from "../apps/extension/lib/archive";
import { saveCandidate } from "../apps/extension/lib/archive-save";
import { Gifts } from "../apps/extension/entrypoints/newtab/components/Gifts";
import { entryFromCandidate, type ReaderEntry } from "../apps/extension/entrypoints/newtab/readerEntry";

const BASE = "http://127.0.0.1:8080";
const UNLOCK = "https://www.nytimes.com/2026/10/16/us/cities.html?unlocked_article_code=abc";
const CANONICAL = "https://www.nytimes.com/2026/10/16/us/cities.html";
const GIFT_ID = "Hq7mK2pa";
const SNAPSHOT_ID = "K7mQp";

interface Call {
  url: string;
  method: string;
  body?: string;
}

let calls: Call[] = [];
let restoreFetch: (() => void) | null = null;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function installFetch(handler: (url: string, init: RequestInit | undefined) => Response | Promise<Response>) {
  calls = [];
  const previous = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : undefined });
    return handler(url, init);
  }) as typeof fetch;
  restoreFetch = () => {
    globalThis.fetch = previous;
  };
}

afterEach(() => {
  restoreFetch?.();
  restoreFetch = null;
});

function candidatePayload(extra: Record<string, unknown> = {}) {
  return {
    id: GIFT_ID,
    unlock_url: UNLOCK,
    canonical_url: CANONICAL,
    site: "The New York Times",
    publisher: "nyt",
    title: "Cities after the storm",
    source_url: "https://bsky.app/profile/ada/post/1",
    source_author: "@ada",
    found_at: "2026-10-17T11:02:00Z",
    expires_at: "2026-10-24T11:02:00Z",
    expires_estimated: true,
    status: "new",
    archived: null,
    ...extra,
  };
}

function articleText(id = SNAPSHOT_ID, url = CANONICAL) {
  return {
    id,
    url,
    final_url: url,
    title: "Cities after the storm",
    site: "The New York Times",
    author: "Ada",
    published_at: null,
    created_at: "2026-10-17T12:00:00Z",
    word_count: 400,
    paywalled: false,
    text: "The city rebuilt.",
  };
}

test("listCandidates reads the live queue and maps Amber's names", async () => {
  installFetch((url) => {
    expect(url).toBe(`${BASE}/api/candidates`);
    return json(200, {
      candidates: [
        candidatePayload({ archived: { id: SNAPSHOT_ID, usable: true } }),
        { id: "", unlock_url: UNLOCK },
        { unlock_url: UNLOCK },
        null,
      ],
      updated_at: "2026-10-17T12:00:00Z",
    });
  });
  const list = await createArchiveBridge(BASE).listCandidates();
  expect(list).toEqual([
    {
      id: GIFT_ID,
      unlockUrl: UNLOCK,
      canonicalUrl: CANONICAL,
      site: "The New York Times",
      publisher: "nyt",
      title: "Cities after the storm",
      sourceUrl: "https://bsky.app/profile/ada/post/1",
      sourceAuthor: "@ada",
      foundAt: "2026-10-17T11:02:00Z",
      expiresAt: "2026-10-24T11:02:00Z",
      expiresEstimated: true,
      status: "new",
      archivedId: SNAPSHOT_ID,
    },
  ]);
  expect(calls).toHaveLength(1);
  expect(calls[0].method).toBe("GET");
});

test("listCandidates is empty when Amber has no gifts and fails when Amber is down", async () => {
  installFetch(() => json(200, { candidates: [], updated_at: "2026-10-17T12:00:00Z" }));
  expect(await createArchiveBridge(BASE).listCandidates()).toEqual([]);

  installFetch(() => json(503, { detail: "down" }));
  await expect(createArchiveBridge(BASE).listCandidates()).rejects.toThrow(/503/);

  installFetch(() => {
    throw new TypeError("network");
  });
  await expect(createArchiveBridge(BASE).listCandidates()).rejects.toThrow(/network/);
  await expect(createArchiveBridge("").listCandidates()).rejects.toThrow(/Invalid archive URL/);
});

test("entryFromCandidate carries the gift and does not allow a save until a click", () => {
  const [gift] = [
    {
      id: GIFT_ID,
      unlockUrl: UNLOCK,
      canonicalUrl: CANONICAL,
      site: "The New York Times",
      publisher: "nyt",
      title: "Cities after the storm",
      sourceAuthor: "@ada",
      foundAt: "2026-10-17T11:02:00Z",
      expiresEstimated: true,
      status: "new",
      archivedId: SNAPSHOT_ID,
    },
  ];
  const entry = entryFromCandidate(gift);
  expect(entry.autoFetch).toBe(false);
  expect(entry.candidateId).toBe(GIFT_ID);
  expect(entry.unlockUrl).toBe(UNLOCK);
  expect(entry.url).toBe(CANONICAL);
  expect(entry.archiveId).toBeUndefined();
  expect(entry.key).toBe(`gift:${GIFT_ID}`);
});

test("saveCandidate posts an empty body, then polls and reads", async () => {
  installFetch((url) => {
    if (url.endsWith(`/api/candidates/${GIFT_ID}/save`)) {
      return json(202, { id: SNAPSHOT_ID, status: "queued", candidate: GIFT_ID });
    }
    if (url.endsWith(`/api/jobs/${SNAPSHOT_ID}`)) return json(200, { id: SNAPSHOT_ID, status: "complete" });
    if (url.endsWith(`/api/snapshots/${SNAPSHOT_ID}/text`)) return json(200, articleText());
    return json(500, { detail: url });
  });
  const result = await saveCandidate(BASE, { id: GIFT_ID, canonicalUrl: CANONICAL });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.text).toBe("The city rebuilt.");
  expect(result.created).toBe(true);
  expect(result.id).toBe(SNAPSHOT_ID);
  const save = calls.find((call) => call.url.endsWith("/save"));
  expect(save?.method).toBe("POST");
  expect(save?.body).toBe("{}");
  expect(calls.some((call) => call.url.includes(UNLOCK))).toBe(false);
});

test("saveCandidate reports a paywall without capturing anything else", async () => {
  installFetch(() => json(200, { id: SNAPSHOT_ID, status: "exists", usable: false }));
  const result = await saveCandidate(BASE, { id: GIFT_ID, canonicalUrl: CANONICAL });
  expect(result).toMatchObject({ ok: false, reason: "paywall-stub", id: SNAPSHOT_ID });
  expect(calls).toHaveLength(1);
  expect(calls[0].body).toBe("{}");
});

test("a finished gift capture with no article text is still a paywall", async () => {
  installFetch((url) => {
    if (url.endsWith("/save")) return json(202, { id: SNAPSHOT_ID, status: "queued", candidate: GIFT_ID });
    if (url.includes("/jobs/")) return json(200, { status: "complete" });
    return json(404, { detail: "no text" });
  });
  const result = await saveCandidate(BASE, { id: GIFT_ID });
  expect(result).toMatchObject({ ok: false, reason: "paywall-stub" });
  expect(calls.some((call) => call.url.includes("/api/import"))).toBe(false);
  expect(calls.some((call) => call.url.endsWith("/api/save"))).toBe(false);
});

test("an expired gift falls back to a normal save of the canonical url", async () => {
  installFetch((url, init) => {
    if (url.endsWith(`/api/candidates/${GIFT_ID}/save`)) {
      return json(410, { detail: "gift link expired", canonical_url: CANONICAL });
    }
    if (url.includes("/api/lookup")) return json(200, { found: false });
    if (url.endsWith("/api/save")) return json(202, { id: SNAPSHOT_ID, status: "queued" });
    if (url.includes("/api/jobs/")) return json(200, { status: "complete" });
    if (url.endsWith("/text")) return json(200, articleText());
    return json(500, { detail: `${init?.method ?? "GET"} ${url}` });
  });
  const result = await saveCandidate(BASE, { id: GIFT_ID, canonicalUrl: UNLOCK });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.text).toBe("The city rebuilt.");
  const posted = calls.filter((call) => call.method === "POST");
  expect(posted.map((call) => call.url)).toEqual([
    `${BASE}/api/candidates/${GIFT_ID}/save`,
    `${BASE}/api/save`,
  ]);
  expect(posted[0].body).toBe("{}");
  expect(JSON.parse(posted[1].body ?? "")).toEqual({ url: CANONICAL });
  expect(posted[1].body).not.toContain("unlocked_article_code");
});

test("an expired gift with no canonical address is not saved", async () => {
  installFetch(() => json(410, { detail: "gift link expired", canonical_url: null }));
  const result = await saveCandidate(BASE, { id: GIFT_ID });
  expect(result).toMatchObject({ ok: false, reason: "invalid-url" });
  expect(calls).toHaveLength(1);
  expect(calls[0].url).toContain("/api/candidates/");
});

test("an expired gift uses the canonical address the queue already had", async () => {
  installFetch((url) => {
    if (url.includes("/candidates/") && url.endsWith("/save")) {
      return json(410, { detail: "gift link expired", canonical_url: null });
    }
    if (url.includes("/api/lookup")) return json(200, { found: false });
    if (url.endsWith("/api/save")) return json(202, { id: SNAPSHOT_ID, status: "capturing" });
    if (url.includes("/api/jobs/")) return json(200, { status: "complete" });
    if (url.endsWith("/text")) return json(200, articleText(SNAPSHOT_ID, CANONICAL));
    return json(500, {});
  });
  const result = await saveCandidate(BASE, { id: GIFT_ID, canonicalUrl: CANONICAL });
  expect(result.ok).toBe(true);
  const save = calls.find((call) => call.url.endsWith("/api/save"));
  expect(JSON.parse(save?.body ?? "")).toEqual({ url: CANONICAL });
});

function installDom() {
  const win = new Window({ url: `${BASE}/` });
  const target = globalThis as unknown as Record<string, unknown>;
  target.window = win;
  target.document = win.document;
  target.HTMLElement = win.HTMLElement;
  target.Element = win.Element;
  target.Node = win.Node;
  target.navigator = win.navigator;
  target.DocumentFragment = win.DocumentFragment;
  target.MutationObserver = win.MutationObserver;
  target.getComputedStyle = win.getComputedStyle.bind(win);
  target.IS_REACT_ACT_ENVIRONMENT = true;
  return win;
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

async function renderGifts(node: ReactNode) {
  installDom();
  const host = document.createElement("div");
  document.body.appendChild(host);
  let root: Root;
  await act(async () => {
    root = createRoot(host);
    root.render(node);
  });
  await settle();
  return {
    host,
    unmount() {
      act(() => root.unmount());
    },
  };
}

const THREE_DAYS = 3 * 24 * 60 * 60 * 1000 + 60 * 60 * 1000;

test("the gifts section renders age, the archive marker and dismiss, and hides when Amber is down or empty", async () => {
  const foundAt = new Date(Date.now() - THREE_DAYS).toISOString();
  const otherId = "Bk2nP8qs";
  let mode: "list" | "empty" | "down" = "list";
  installFetch((url, init) => {
    const method = init?.method ?? "GET";
    if (method === "POST" && url.endsWith("/dismiss")) return json(200, { id: otherId, status: "dismissed" });
    if (mode === "down") return Promise.reject(new TypeError("network"));
    if (mode === "empty") return json(200, { candidates: [], updated_at: foundAt });
    return json(200, {
      candidates: [
        candidatePayload({ found_at: foundAt, archived: { id: SNAPSHOT_ID, usable: true } }),
        candidatePayload({
          id: otherId,
          title: "A second gift",
          unlock_url: "https://www.ft.com/content/abc",
          canonical_url: "https://www.ft.com/content/abc",
          site: "Financial Times",
          publisher: "ft",
          found_at: foundAt,
          archived: null,
        }),
      ],
      updated_at: foundAt,
    });
  });

  const opened: ReaderEntry[] = [];
  const view = await renderGifts(
    <Gifts
      archiveUrl={BASE}
      active
      reloadToken={0}
      blockedSites={[]}
      saved={new Map()}
      now={Date.now()}
      cursorId={null}
      onCursor={() => undefined}
      onOpen={(entry) => opened.push(entry)}
    />,
  );

  const section = document.querySelector("section.gifts");
  expect(section?.getAttribute("aria-label")).toBe("Gifts");
  expect(section?.textContent).toContain("Cities after the storm");
  expect(section?.textContent).toContain("The New York Times");
  expect(section?.textContent).toContain("@ada");
  expect(section?.textContent).toContain("3 d ago");
  expect(section?.textContent).toContain("In Amber");
  expect(section?.textContent).toContain("A second gift");
  const amberMarks = section?.querySelectorAll(".row-amber") ?? [];
  expect(amberMarks.length).toBe(1);

  const row = document.getElementById(`lrow-${GIFT_ID}`) as HTMLButtonElement;
  await act(async () => {
    row.click();
  });
  expect(opened).toHaveLength(1);
  expect(opened[0].autoFetch).toBe(false);
  expect(opened[0].candidateId).toBe(GIFT_ID);
  expect(opened[0].unlockUrl).toBe(UNLOCK);
  expect(calls.some((call) => call.method === "POST")).toBe(false);

  const dismiss = document.querySelector(`button[aria-label="Dismiss A second gift"]`) as HTMLButtonElement;
  await act(async () => {
    dismiss.click();
  });
  await settle();
  expect(calls.some((call) => call.method === "POST" && call.url.endsWith(`/api/candidates/${otherId}/dismiss`) && call.body === "{}")).toBe(true);
  expect(opened).toHaveLength(1);
  expect(document.body.textContent).not.toContain("A second gift");
  expect(document.body.textContent).toContain("Cities after the storm");

  view.unmount();

  mode = "empty";
  const empty = await renderGifts(
    <Gifts
      archiveUrl={BASE}
      active
      reloadToken={1}
      blockedSites={[]}
      saved={new Map()}
      now={Date.now()}
      cursorId={null}
      onCursor={() => undefined}
      onOpen={() => undefined}
    />,
  );
  expect(document.querySelector("section.gifts")).toBeNull();
  empty.unmount();

  mode = "down";
  const down = await renderGifts(
    <Gifts
      archiveUrl={BASE}
      active
      reloadToken={2}
      blockedSites={[]}
      saved={new Map()}
      now={Date.now()}
      cursorId={null}
      onCursor={() => undefined}
      onOpen={() => undefined}
    />,
  );
  expect(document.querySelector("section.gifts")).toBeNull();
  down.unmount();

  mode = "list";
  const blocked = await renderGifts(
    <Gifts
      archiveUrl={BASE}
      active
      reloadToken={3}
      blockedSites={["nytimes.com", "ft.com"]}
      saved={new Map()}
      now={Date.now()}
      cursorId={null}
      onCursor={() => undefined}
      onOpen={() => undefined}
    />,
  );
  expect(document.querySelector("section.gifts")).toBeNull();
  blocked.unmount();
});
