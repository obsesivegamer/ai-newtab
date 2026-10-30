import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DEFAULT_MODEL } from "@homepage/agent-core";
import { SettingsModal } from "../apps/extension/entrypoints/newtab/components/SettingsModal";
import { READER_BASIC_USER, basicAuthorization } from "../apps/extension/lib/archive-auth";
import { KEYS } from "../apps/extension/lib/storage";

const MAC = "http://127.0.0.1:8080";
const READER = "https://dell-plx-reader.tailf9612a.ts.net";
const PASSWORD = "s3cret-reader";
const BASIC = basicAuthorization(READER_BASIC_USER, PASSWORD);

interface Seen {
  url: string;
  authorization: string | null;
  redirect: RequestRedirect | undefined;
}

const store = new Map<string, unknown>();
let seen: Seen[] = [];
let restoreFetch: (() => void) | undefined;
let restoreDom: (() => void) | undefined;
let restoreWarn: (() => void) | undefined;
const warnings: string[] = [];

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
  history: {
    async search(): Promise<unknown[]> {
      return [];
    },
  },
};

afterEach(() => {
  restoreFetch?.();
  restoreFetch = undefined;
  restoreDom?.();
  restoreDom = undefined;
  restoreWarn?.();
  restoreWarn = undefined;
  warnings.length = 0;
  store.clear();
  seen = [];
  delete (globalThis as { browser?: unknown }).browser;
});

function installBrowser() {
  (globalThis as unknown as { browser: typeof mockBrowser }).browser = mockBrowser;
}

function installFetch() {
  seen = [];
  const previous = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    seen.push({
      url,
      authorization: new Headers(init?.headers).get("authorization"),
      redirect: init?.redirect,
    });
    if (url.includes("/api/snapshots")) {
      return new Response(JSON.stringify({ total_usable: 2 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("no", { status: 404 });
  }) as typeof fetch;
  restoreFetch = () => {
    globalThis.fetch = previous;
  };
}

function watchWarnings() {
  const previous = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((arg) => String(arg)).join(" "));
  };
  restoreWarn = () => {
    console.warn = previous;
  };
}

function installDom() {
  const win = new Window({ url: "http://127.0.0.1:8080/" });
  const target = globalThis as unknown as Record<string, unknown>;
  const previous = {
    window: target.window,
    document: target.document,
    HTMLElement: target.HTMLElement,
    HTMLInputElement: target.HTMLInputElement,
    Element: target.Element,
    Node: target.Node,
    navigator: target.navigator,
    DocumentFragment: target.DocumentFragment,
    MutationObserver: target.MutationObserver,
    getComputedStyle: target.getComputedStyle,
    IS_REACT_ACT_ENVIRONMENT: target.IS_REACT_ACT_ENVIRONMENT,
  };
  target.window = win;
  target.document = win.document;
  target.HTMLElement = win.HTMLElement;
  target.HTMLInputElement = win.HTMLInputElement;
  target.Element = win.Element;
  target.Node = win.Node;
  target.navigator = win.navigator;
  target.DocumentFragment = win.DocumentFragment;
  target.MutationObserver = win.MutationObserver;
  target.getComputedStyle = win.getComputedStyle.bind(win);
  target.IS_REACT_ACT_ENVIRONMENT = true;
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

function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  if (setter) setter.call(input, value);
  else input.value = value;
  const propsKey = Object.keys(input).find((key) => key.startsWith("__reactProps$"));
  const props = propsKey
    ? (input as unknown as Record<string, { onChange?: (event: { target: HTMLInputElement; currentTarget: HTMLInputElement }) => void }>)[propsKey]
    : undefined;
  props?.onChange?.({ target: input, currentTarget: input });
}

function seed(archiveUrl: string) {
  store.set(KEYS.archiveUrl, archiveUrl);
  store.set(KEYS.fallbackArchiveUrl, READER);
  store.set(KEYS.readerPassword, "");
  store.set(KEYS.fallbackArchiveMigrated, 2);
  store.set(KEYS.sources, []);
  store.set(KEYS.sourcesMigrated, 1);
}

function modal(onClose: () => void, onSave: () => void) {
  return (
    <SettingsModal
      initialPrompt=""
      blockedSites={[]}
      model={DEFAULT_MODEL}
      onChangeModel={() => {}}
      autoRebuild={false}
      onToggleAutoRebuild={() => {}}
      intervalHours={24}
      onChangeInterval={() => {}}
      onClose={onClose}
      onSave={onSave}
      canRebuild={false}
    />
  );
}

test("a successful Mac test stores the reader password and does not send it to the Mac", async () => {
  seed(MAC);
  installBrowser();
  installFetch();
  watchWarnings();
  installDom();
  let closed = 0;
  let confirms = 0;
  window.confirm = () => {
    confirms += 1;
    return false;
  };
  const view = await render(modal(() => { closed += 1; }, () => { closed += 1; }));
  const password = view.host.querySelector("#set-reader-password") as HTMLInputElement;
  expect(password.disabled).toBe(false);
  await act(async () => {
    typeInto(password, PASSWORD);
  });
  const testButton = Array.from(view.host.querySelectorAll("button")).find((button) => button.textContent === "Test connection");
  await act(async () => {
    testButton?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  await flush();
  expect(store.get(KEYS.readerPassword) === PASSWORD).toBe(true);
  expect(store.get(KEYS.fallbackArchiveUrl)).toBe(READER);
  expect(store.get(KEYS.archiveUrl)).toBe(MAC);
  const snapshots = seen.filter((call) => call.url.includes("/api/snapshots"));
  expect(snapshots).toHaveLength(1);
  expect(snapshots[0].url.startsWith(MAC)).toBe(true);
  expect(snapshots[0].authorization).toBeNull();
  expect(snapshots[0].redirect).toBeUndefined();
  await act(async () => {
    document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  await flush();
  expect(confirms).toBe(0);
  expect(closed).toBe(1);
  expect(warnings.join("\n").includes(PASSWORD)).toBe(false);
  expect(/authorization/i.test(warnings.join("\n"))).toBe(false);
  view.unmount();
});

test("the Mac field holding the reader address is refused, and nothing is sent", async () => {
  seed(READER);
  installBrowser();
  installFetch();
  watchWarnings();
  installDom();
  const view = await render(modal(() => {}, () => {}));
  const password = view.host.querySelector("#set-reader-password") as HTMLInputElement;
  await act(async () => {
    typeInto(password, PASSWORD);
  });
  const testButton = Array.from(view.host.querySelectorAll("button")).find((button) => button.textContent === "Test connection");
  await act(async () => {
    testButton?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  await flush();
  // Real reads never send the password to the Mac field's origin, so Test must not either.
  expect(view.host.textContent).toContain("That's the offline reader. Put it in the reader field.");
  expect(seen.filter((call) => call.url.includes("/api/snapshots"))).toHaveLength(0);
  expect(store.get(KEYS.readerPassword) ?? "").toBe("");
  expect(warnings.join("\n").includes(PASSWORD)).toBe(false);
  view.unmount();
});

test("Escape and Cancel ask to discard, and Cancel in the prompt keeps the form open", async () => {
  seed(MAC);
  installBrowser();
  installFetch();
  installDom();
  let closed = 0;
  let saved = 0;
  const asked: string[] = [];
  let answer = false;
  window.confirm = (message?: string) => {
    asked.push(String(message));
    return answer;
  };
  const stays = await render(modal(() => { closed += 1; }, () => { saved += 1; }));
  const password = stays.host.querySelector("#set-reader-password") as HTMLInputElement;
  await act(async () => {
    typeInto(password, PASSWORD);
  });
  await act(async () => {
    document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  await flush();
  expect(asked).toEqual(["Discard unsaved changes?"]);
  expect(closed).toBe(0);
  expect(saved).toBe(0);
  expect(store.get(KEYS.readerPassword) ?? "").toBe("");
  stays.unmount();

  answer = true;
  const drops = await render(modal(() => { closed += 1; }, () => { saved += 1; }));
  const again = drops.host.querySelector("#set-reader-password") as HTMLInputElement;
  await act(async () => {
    typeInto(again, PASSWORD);
  });
  const cancel = Array.from(drops.host.querySelectorAll("button")).find((button) => button.textContent === "Cancel");
  await act(async () => {
    cancel?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  await flush();
  expect(closed).toBe(1);
  expect(saved).toBe(0);
  expect(store.get(KEYS.readerPassword) ?? "").toBe("");
  drops.unmount();
});

test("closing the tab with unsaved changes triggers the browser's own prompt", async () => {
  seed(MAC);
  installBrowser();
  installFetch();
  installDom();
  const view = await render(modal(() => {}, () => {}));
  const clean = new window.Event("beforeunload", { cancelable: true });
  window.dispatchEvent(clean);
  expect(clean.defaultPrevented).toBe(false);

  const password = view.host.querySelector("#set-reader-password") as HTMLInputElement;
  await act(async () => {
    typeInto(password, PASSWORD);
  });
  const dirty = new window.Event("beforeunload", { cancelable: true });
  window.dispatchEvent(dirty);
  expect(dirty.defaultPrevented).toBe(true);

  view.unmount();
  const gone = new window.Event("beforeunload", { cancelable: true });
  window.dispatchEvent(gone);
  expect(gone.defaultPrevented).toBe(false);
});
