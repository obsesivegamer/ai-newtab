import { afterEach, expect, jest, test } from "bun:test";
import { Window } from "happy-dom";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { HomepagePreviewBoundary } from "../apps/extension/entrypoints/newtab/components/HomepagePreview";
import { canShowHomepagePreview } from "../apps/extension/entrypoints/newtab/components/homepagePreviewGate";
import { DEFAULT_FALLBACK_ARCHIVE_URL } from "../apps/extension/lib/archive-auth";
import { TodayStatic } from "../apps/web/src/TodayStatic";
import { ASKED_MAC, TODAY_POLL_MS } from "../apps/web/src/todayStatus";

const ORIGIN = "http://dell-plx-reader:8081";
const HOUR = 60 * 60 * 1000;

interface Seen {
  url: string;
  method: string;
  authorization: string | null;
  credentials: RequestCredentials | undefined;
  body?: string;
}

let seen: Seen[] = [];
let homepage: { code: string; timestamp: string; synced_at?: string };
let rebuildStatus = 200;
let holdHomepage: Promise<void> | null = null;
let releaseHomepage: (() => void) | undefined;
let restoreFetch: (() => void) | undefined;
let restoreDom: (() => void) | undefined;

afterEach(() => {
  restoreFetch?.();
  restoreFetch = undefined;
  restoreDom?.();
  restoreDom = undefined;
  holdHomepage = null;
  releaseHomepage = undefined;
  jest.useRealTimers();
});

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function installFetch() {
  seen = [];
  const previous = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    seen.push({
      url,
      method: init?.method ?? "GET",
      authorization: new Headers(init?.headers).get("authorization"),
      credentials: init?.credentials,
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    if (url.endsWith("/api/homepage/rebuild-request")) {
      return json(rebuildStatus, { requested_at: new Date().toISOString(), id: "r1", fulfilled_at: null });
    }
    if (holdHomepage) await holdHomepage;
    return json(200, homepage);
  }) as typeof fetch;
  restoreFetch = () => {
    globalThis.fetch = previous;
  };
}

function holdNextHomepage() {
  holdHomepage = new Promise((resolve) => {
    releaseHomepage = () => {
      holdHomepage = null;
      resolve();
    };
  });
}

function installDom(secure: boolean) {
  const win = new Window({ url: `${ORIGIN}/app/` });
  Object.defineProperty(win, "isSecureContext", { configurable: true, value: secure });
  Object.defineProperty(win, "crypto", {
    configurable: true,
    value: secure ? { subtle: { digest() {} } } : {},
  });
  const target = globalThis as unknown as Record<string, unknown>;
  const previous = {
    window: target.window,
    document: target.document,
    HTMLElement: target.HTMLElement,
    Element: target.Element,
    Node: target.Node,
    navigator: target.navigator,
    DocumentFragment: target.DocumentFragment,
    MutationObserver: target.MutationObserver,
    getComputedStyle: target.getComputedStyle,
    IS_REACT_ACT_ENVIRONMENT: target.IS_REACT_ACT_ENVIRONMENT,
    isSecureContext: target.isSecureContext,
    crypto: target.crypto,
  };
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
  target.isSecureContext = secure;
  target.crypto = secure ? { subtle: {} } : {};
  restoreDom = () => {
    for (const [key, value] of Object.entries(previous)) target[key] = value;
  };
  return win;
}

async function flush() {
  for (let i = 0; i < 12; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function render(node: ReactNode) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  let root: Root;
  await act(async () => {
    root = createRoot(host);
    root.render(node);
  });
  await flush();
  return {
    host,
    unmount() {
      act(() => root.unmount());
    },
  };
}

test("the preview mounts only in a secure context with crypto.subtle", () => {
  expect(canShowHomepagePreview({ isSecureContext: true, crypto: { subtle: {} } })).toBe(true);
  expect(canShowHomepagePreview({ isSecureContext: false, crypto: { subtle: {} } })).toBe(false);
  expect(canShowHomepagePreview({ isSecureContext: true, crypto: {} })).toBe(false);
  expect(canShowHomepagePreview({ isSecureContext: true })).toBe(false);
});

test("an insecure Today page links to the HTTPS reader instead of mounting a frame", async () => {
  const now = Date.now();
  homepage = {
    code: "export default function App(){ return <p>Hi</p> }",
    timestamp: new Date(now - 13 * HOUR).toISOString(),
    synced_at: new Date(now - 2 * HOUR).toISOString(),
  };
  rebuildStatus = 200;
  installFetch();
  installDom(false);
  const view = await render(<TodayStatic origin={ORIGIN} active />);
  expect(view.host.textContent).toContain("Today needs HTTPS.");
  expect(view.host.querySelector("a")?.getAttribute("href")).toBe(DEFAULT_FALLBACK_ARCHIVE_URL);
  expect(view.host.textContent).toContain("This page is 13h old. synced 2h ago");
  expect(view.host.querySelector("iframe")).toBeNull();
  view.unmount();
});

test("the preview error boundary replaces a frame that throws", async () => {
  installDom(true);
  const previous = console.error;
  console.error = () => {};
  function Boom(): ReactNode {
    throw new Error("frame failed");
  }
  const view = await render(
    <HomepagePreviewBoundary>
      <Boom />
    </HomepagePreviewBoundary>,
  );
  console.error = previous;
  expect(view.host.textContent).toContain("The preview hit an error on this page.");
  view.unmount();
});

test("Refresh reports checking, then up to date, and asks the Mac when nothing changed", async () => {
  jest.useFakeTimers();
  const now = Date.now();
  const timestamp = new Date(now - 30 * 60_000).toISOString();
  homepage = { code: "export default function App(){ return <p>Old</p> }", timestamp };
  rebuildStatus = 200;
  installFetch();
  installDom(false);
  const view = await render(<TodayStatic origin={ORIGIN} active />);
  expect(view.host.textContent).not.toContain(" old");

  holdNextHomepage();
  const button = view.host.querySelector("button");
  expect(button).toBeTruthy();
  await act(async () => {
    button?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
  });
  expect(button?.textContent).toBe("Checking…");
  expect((button as HTMLButtonElement).disabled).toBe(true);

  releaseHomepage?.();
  await flush();
  expect(view.host.textContent).toContain("Up to date. Built");
  expect(view.host.textContent).toContain(ASKED_MAC);
  expect((button as HTMLButtonElement).disabled).toBe(false);
  const posted = seen.filter((call) => call.method === "POST");
  expect(posted).toHaveLength(1);
  expect(posted[0].url).toBe(`${ORIGIN}/api/homepage/rebuild-request`);
  expect(posted[0].authorization).toBeNull();
  expect(posted[0].credentials).toBe("same-origin");
  expect(posted[0].body).toBe("{}");

  homepage = { ...homepage, code: "export default function App(){ return <p>New</p> }", timestamp: new Date(Date.now() + 1000).toISOString() };
  await act(async () => {
    jest.advanceTimersByTime(TODAY_POLL_MS);
  });
  await flush();
  expect(view.host.textContent).toContain("Updated");
  view.unmount();
});

test("a missing rebuild endpoint stays hidden and is not asked again", async () => {
  homepage = {
    code: "export default function App(){ return <p>Old</p> }",
    timestamp: new Date(Date.now() - 2 * HOUR).toISOString(),
  };
  rebuildStatus = 404;
  installFetch();
  installDom(false);
  const view = await render(<TodayStatic origin={ORIGIN} active />);
  const button = view.host.querySelector("button");
  await act(async () => {
    button?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  await flush();
  expect(view.host.textContent).toContain("Up to date. Built");
  expect(view.host.textContent).not.toContain(ASKED_MAC);
  const firstPosts = seen.filter((call) => call.method === "POST").length;
  expect(firstPosts).toBe(1);

  await act(async () => {
    button?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  await flush();
  expect(view.host.textContent).toContain("Up to date. Built");
  expect(seen.filter((call) => call.method === "POST")).toHaveLength(firstPosts);
  view.unmount();
});
