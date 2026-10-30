import { afterEach, expect, jest, test } from "bun:test";
import { Window } from "happy-dom";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { HomepagePreviewBoundary } from "../apps/extension/entrypoints/newtab/components/HomepagePreview";
import { canShowHomepagePreview } from "../apps/extension/entrypoints/newtab/components/homepagePreviewGate";
import { DEFAULT_FALLBACK_ARCHIVE_URL } from "../apps/extension/lib/archive-auth";
import { TodayStatic } from "../apps/web/src/TodayStatic";
import { rebuildRequestError } from "../apps/extension/lib/phone-sync";
import {
  ASKED_MAC,
  REBUILD_EXPIRED,
  REBUILD_ROUTE_MISSING,
  REBUILD_WAIT_TIMED_OUT,
  TODAY_POLL_LIMIT_MS,
  TODAY_POLL_MS,
  UNREADABLE_BUILD_TIME,
  homepageArrived,
  timestampAdvanced,
} from "../apps/web/src/todayStatus";

const ORIGIN = "http://dell-plx-reader:8081";
const HOUR = 60 * 60 * 1000;

interface Seen {
  url: string;
  method: string;
  authorization: string | null;
  credentials: RequestCredentials | undefined;
  contentType: string | null;
  body?: string;
}

let seen: Seen[] = [];
let homepage: { code: string; timestamp: string; synced_at?: string; rebuild_request?: Record<string, unknown> };
let followupHomepage: typeof homepage | undefined;
/** Homepage GETs up to this count return `homepage`; later ones return `followupHomepage`. */
let followupAfter = Number.POSITIVE_INFINITY;
let homepageGets = 0;
let rebuildStatus = 200;
let rebuildBody: Record<string, unknown> | undefined;
let rebuildThrow = false;
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
  rebuildBody = undefined;
  rebuildStatus = 200;
  rebuildThrow = false;
  followupHomepage = undefined;
  followupAfter = Number.POSITIVE_INFINITY;
  homepageGets = 0;
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
  homepageGets = 0;
  const previous = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    seen.push({
      url,
      method: init?.method ?? "GET",
      authorization: new Headers(init?.headers).get("authorization"),
      credentials: init?.credentials,
      contentType: new Headers(init?.headers).get("content-type"),
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    if (url.endsWith("/api/homepage/rebuild-request")) {
      if (rebuildThrow) throw new TypeError("network down");
      return json(
        rebuildStatus,
        rebuildBody ?? { requested_at: new Date().toISOString(), id: "r1", fulfilled_at: null },
      );
    }
    homepageGets += 1;
    if (holdHomepage) await holdHomepage;
    const body = followupHomepage && homepageGets > followupAfter ? followupHomepage : homepage;
    return json(200, body);
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
  expect(view.host.querySelector("a")?.getAttribute("href")).toBe(`${DEFAULT_FALLBACK_ARCHIVE_URL}/app/`);
  expect(view.host.textContent).toContain("This page is 13h old. Synced 2h ago");
  expect(view.host.textContent).not.toContain("Up to date");
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

test("the preview error boundary recovers when the page changes", async () => {
  installDom(true);
  const previous = console.error;
  console.error = () => {};
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  function Frame({ boom }: { boom: boolean }) {
    if (boom) throw new Error("frame failed");
    return <p>Shown</p>;
  }
  await act(async () => {
    root.render(
      <HomepagePreviewBoundary resetKey="a">
        <Frame boom />
      </HomepagePreviewBoundary>,
    );
  });
  expect(host.textContent).toContain("The preview hit an error on this page.");
  await act(async () => {
    root.render(
      <HomepagePreviewBoundary resetKey="b">
        <Frame boom={false} />
      </HomepagePreviewBoundary>,
    );
  });
  await flush();
  expect(host.textContent).toContain("Shown");
  console.error = previous;
  act(() => root.unmount());
});

test("Updated is only a strictly newer timestamp", () => {
  const same = "2026-10-29T15:00:00.000Z";
  expect(timestampAdvanced(same, same)).toBe(false);
  expect(timestampAdvanced(same, "2026-10-29T15:00:00Z")).toBe(false);
  expect(timestampAdvanced("", same)).toBe(false);
  expect(timestampAdvanced(same, "not-a-time")).toBe(false);
  expect(timestampAdvanced(same, "2026-10-29T15:00:01.000Z")).toBe(true);
  expect(homepageArrived(same, "2026-10-29T15:00:01.000Z")).toBe(true);
  expect(homepageArrived("not-a-time", same)).toBe(true);
  expect(homepageArrived(same, same)).toBe(false);
  expect(ASKED_MAC).toContain("auto-rebuild");
  expect(ASKED_MAC).toContain("API key");
  expect(REBUILD_WAIT_TIMED_OUT).toContain(ASKED_MAC.slice(ASKED_MAC.indexOf("Chrome")));
});

test("Refresh on a fresh page says it is up to date and does not ask the Mac", async () => {
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
  expect(view.host.textContent).not.toContain("Updated");
  expect(view.host.textContent).not.toContain(ASKED_MAC);
  expect((button as HTMLButtonElement).disabled).toBe(false);
  expect(seen.filter((call) => call.method === "POST")).toHaveLength(0);
  view.unmount();
});

test("a stale refresh asks the Mac, then says Updated only when a newer page arrives", async () => {
  jest.useFakeTimers();
  const now = Date.now();
  const timestamp = new Date(now - 2 * HOUR).toISOString();
  homepage = { code: "export default function App(){ return <p>Old</p> }", timestamp };
  rebuildStatus = 200;
  installFetch();
  installDom(false);
  const view = await render(<TodayStatic origin={ORIGIN} active />);
  const button = view.host.querySelector("button");
  await act(async () => {
    button?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  await flush();
  expect(view.host.textContent).toContain(ASKED_MAC);
  expect(view.host.textContent).not.toContain("Up to date");
  expect(view.host.textContent).not.toContain("Updated");
  const posted = seen.filter((call) => call.method === "POST");
  expect(posted).toHaveLength(1);
  expect(posted[0].url).toBe(`${ORIGIN}/api/homepage/rebuild-request`);
  expect(posted[0].authorization).toBeNull();
  expect(posted[0].credentials).toBe("same-origin");
  expect(posted[0].contentType).toBe("application/json");
  expect(posted[0].body).toBe("{}");

  homepage = {
    ...homepage,
    code: "export default function App(){ return <p>New</p> }",
    timestamp: new Date(Date.parse(timestamp) + 1000).toISOString(),
  };
  await act(async () => {
    jest.advanceTimersByTime(TODAY_POLL_MS);
  });
  await flush();
  expect(view.host.textContent).toContain("Updated");
  expect(view.host.textContent).not.toContain(ASKED_MAC);
  view.unmount();
});

test("a cooldown response says when the page was built and reads the homepage once more", async () => {
  const timestamp = new Date(Date.now() - 2 * HOUR).toISOString();
  homepage = { code: "export default function App(){ return <p>Old</p> }", timestamp };
  rebuildBody = {
    requested_at: new Date().toISOString(),
    id: "req-cool",
    fulfilled_at: timestamp,
    baseline_timestamp: timestamp,
    cooldown: true,
  };
  installFetch();
  installDom(false);
  const view = await render(<TodayStatic origin={ORIGIN} active />);
  const button = view.host.querySelector("button");
  await act(async () => {
    button?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  await flush();
  expect(view.host.textContent).toContain("Built 2h ago");
  expect(view.host.textContent).not.toContain("up to date");
  expect(view.host.textContent).not.toContain("Up to date");
  expect(view.host.textContent).not.toContain(ASKED_MAC);
  expect(seen.filter((call) => call.method === "POST")).toHaveLength(1);
  expect(seen.filter((call) => call.url === `${ORIGIN}/api/homepage`)).toHaveLength(3);
  view.unmount();
});

test("a cooldown response shows the homepage when the extra read is newer", async () => {
  const timestamp = new Date(Date.now() - 2 * HOUR).toISOString();
  homepage = { code: "export default function App(){ return <p>Old</p> }", timestamp };
  followupAfter = 2;
  followupHomepage = {
    code: "export default function App(){ return <p>New</p> }",
    timestamp: new Date(Date.parse(timestamp) + 1000).toISOString(),
  };
  rebuildBody = {
    requested_at: new Date().toISOString(),
    id: "req-cool",
    fulfilled_at: timestamp,
    baseline_timestamp: timestamp,
    cooldown: true,
  };
  installFetch();
  installDom(false);
  const view = await render(<TodayStatic origin={ORIGIN} active />);
  const button = view.host.querySelector("button");
  await act(async () => {
    button?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  await flush();
  expect(view.host.textContent).toContain("Updated");
  expect(view.host.textContent).not.toContain("Built 2h ago");
  expect(view.host.textContent).not.toContain(ASKED_MAC);
  view.unmount();
});

test("the wait for a rebuild ends with a timeout instead of leaving the ask up", async () => {
  jest.useFakeTimers();
  homepage = {
    code: "export default function App(){ return <p>Old</p> }",
    timestamp: new Date(Date.now() - 2 * HOUR).toISOString(),
  };
  installFetch();
  installDom(false);
  const view = await render(<TodayStatic origin={ORIGIN} active />);
  const button = view.host.querySelector("button");
  await act(async () => {
    button?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  await flush();
  expect(view.host.textContent).toContain(ASKED_MAC);

  await act(async () => {
    jest.advanceTimersByTime(TODAY_POLL_LIMIT_MS);
  });
  await flush();
  expect(view.host.textContent).toContain(REBUILD_WAIT_TIMED_OUT);
  expect(view.host.textContent).not.toContain(ASKED_MAC);
  expect(view.host.textContent).not.toContain("Up to date");
  view.unmount();
});

test("an hourly reload does not say Updated when only the sync time changed", async () => {
  jest.useFakeTimers();
  const timestamp = new Date(Date.now() - 30 * 60_000).toISOString();
  homepage = {
    code: "export default function App(){ return <p>Same</p> }",
    timestamp,
    synced_at: new Date(Date.now() - HOUR).toISOString(),
  };
  installFetch();
  installDom(false);
  const view = await render(<TodayStatic origin={ORIGIN} active />);
  expect(view.host.textContent).not.toContain("Updated");

  homepage = {
    ...homepage,
    code: "export default function App(){ return <p>Copied</p> }",
    synced_at: new Date().toISOString(),
  };
  await act(async () => {
    jest.advanceTimersByTime(6 * 60_000);
    document.dispatchEvent(new window.Event("visibilitychange"));
  });
  await flush();
  expect(view.host.textContent).not.toContain("Updated");

  homepage = { ...homepage, timestamp: new Date(Date.parse(timestamp) + 1000).toISOString() };
  await act(async () => {
    jest.advanceTimersByTime(6 * 60_000);
    document.dispatchEvent(new window.Event("visibilitychange"));
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
  expect(view.host.textContent).not.toContain("Up to date");
  expect(view.host.textContent).not.toContain(ASKED_MAC);
  const firstPosts = seen.filter((call) => call.method === "POST").length;
  expect(firstPosts).toBe(1);

  await act(async () => {
    button?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  await flush();
  expect(view.host.textContent).not.toContain("Up to date");
  expect(seen.filter((call) => call.method === "POST")).toHaveLength(firstPosts);
  expect(view.host.textContent).not.toContain("Rebuild on Mac");
  expect(view.host.textContent).toContain(REBUILD_ROUTE_MISSING);
  view.unmount();
});

test("Rebuild on Mac skips the request when a newer page is already there", async () => {
  const older = new Date(Date.now() - 2 * HOUR).toISOString();
  homepage = {
    code: "export default function App(){ return <p>Old</p> }",
    timestamp: older,
  };
  followupHomepage = {
    code: "export default function App(){ return <p>New</p> }",
    timestamp: new Date().toISOString(),
  };
  followupAfter = 1;
  installFetch();
  installDom(false);
  const view = await render(<TodayStatic origin={ORIGIN} active />);
  const rebuild = view.host.querySelectorAll("button")[1];
  expect(rebuild?.textContent).toBe("Rebuild on Mac");
  const postsBefore = seen.filter((call) => call.method === "POST").length;
  await act(async () => {
    rebuild?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  await flush();
  expect(seen.filter((call) => call.method === "POST")).toHaveLength(postsBefore);
  expect(view.host.textContent).toContain("Updated");
  expect(view.host.textContent).not.toContain(ASKED_MAC);
  view.unmount();
});

test("Rebuild on Mac still asks when the newer page is itself stale", async () => {
  homepage = {
    code: "export default function App(){ return <p>Old</p> }",
    timestamp: new Date(Date.now() - 5 * HOUR).toISOString(),
  };
  followupHomepage = {
    code: "export default function App(){ return <p>Newer</p> }",
    timestamp: new Date(Date.now() - 3 * HOUR).toISOString(),
  };
  followupAfter = 1;
  installFetch();
  installDom(false);
  const view = await render(<TodayStatic origin={ORIGIN} active />);
  const rebuild = view.host.querySelectorAll("button")[1];
  await act(async () => {
    rebuild?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  await flush();
  expect(seen.filter((call) => call.method === "POST")).toHaveLength(1);
  expect(view.host.textContent).toContain(ASKED_MAC);
  view.unmount();
});

test("Rebuild on Mac asks even when the page is fresh", async () => {
  homepage = {
    code: "export default function App(){ return <p>New</p> }",
    timestamp: new Date(Date.now() - 30 * 60_000).toISOString(),
  };
  installFetch();
  installDom(false);
  const view = await render(<TodayStatic origin={ORIGIN} active />);
  const rebuild = view.host.querySelectorAll("button")[1];
  expect(rebuild?.textContent).toBe("Rebuild on Mac");
  await act(async () => {
    rebuild?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  await flush();
  expect(seen.filter((call) => call.method === "POST")).toHaveLength(1);
  expect(view.host.textContent).toContain(ASKED_MAC);
  expect(view.host.textContent).not.toContain("Up to date");
  view.unmount();
});

test("a failed rebuild POST and an unreadable timestamp each say what happened", async () => {
  homepage = {
    code: "export default function App(){ return <p>Old</p> }",
    timestamp: new Date(Date.now() - 2 * HOUR).toISOString(),
  };
  rebuildStatus = 500;
  installFetch();
  installDom(false);
  const failed = await render(<TodayStatic origin={ORIGIN} active />);
  await act(async () => {
    failed.host.querySelector("button")?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  await flush();
  expect(failed.host.textContent).toContain(rebuildRequestError(500));
  expect(failed.host.textContent).not.toContain(ASKED_MAC);
  failed.unmount();

  rebuildStatus = 415;
  const unsupported = await render(<TodayStatic origin={ORIGIN} active />);
  await act(async () => {
    unsupported.host.querySelector("button")?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  await flush();
  expect(unsupported.host.textContent).toContain(rebuildRequestError(415));
  expect(unsupported.host.textContent).not.toContain(ASKED_MAC);
  unsupported.unmount();

  rebuildStatus = 200;
  rebuildThrow = true;
  const offline = await render(<TodayStatic origin={ORIGIN} active />);
  await act(async () => {
    offline.host.querySelector("button")?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  await flush();
  expect(offline.host.textContent).toContain(rebuildRequestError());
  expect(offline.host.textContent).not.toContain(ASKED_MAC);
  offline.unmount();

  rebuildThrow = false;
  homepage = { ...homepage, timestamp: "not-a-time" };
  const unread = await render(<TodayStatic origin={ORIGIN} active />);
  const postsBefore = seen.filter((call) => call.method === "POST").length;
  await act(async () => {
    unread.host.querySelector("button")?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  await flush();
  expect(unread.host.textContent).toContain(UNREADABLE_BUILD_TIME);
  expect(seen.filter((call) => call.method === "POST")).toHaveLength(postsBefore);
  await act(async () => {
    unread.host.querySelectorAll("button")[1]?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  await flush();
  expect(seen.filter((call) => call.method === "POST")).toHaveLength(postsBefore + 1);
  expect(unread.host.textContent).toContain(ASKED_MAC);
  expect(unread.host.textContent).not.toContain(UNREADABLE_BUILD_TIME);
  unread.unmount();
});

test("expired is taken from a homepage GET while waiting, not from the POST body", async () => {
  jest.useFakeTimers();
  const timestamp = new Date(Date.now() - 2 * HOUR).toISOString();
  homepage = { code: "export default function App(){ return <p>Old</p> }", timestamp };
  rebuildBody = {
    requested_at: new Date().toISOString(),
    id: "req-exp",
    fulfilled_at: null,
    expired: true,
  };
  installFetch();
  installDom(false);
  const view = await render(<TodayStatic origin={ORIGIN} active />);
  await act(async () => {
    view.host.querySelector("button")?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  await flush();
  expect(view.host.textContent).toContain(ASKED_MAC);
  expect(view.host.textContent).not.toContain(REBUILD_EXPIRED);

  homepage = {
    ...homepage,
    rebuild_request: {
      requested_at: new Date().toISOString(),
      id: "req-exp",
      fulfilled_at: null,
      expired: true,
    },
  };
  await act(async () => {
    jest.advanceTimersByTime(TODAY_POLL_MS);
  });
  await flush();
  expect(view.host.textContent).toContain(REBUILD_EXPIRED);
  expect(view.host.textContent).not.toContain(ASKED_MAC);
  view.unmount();
});
