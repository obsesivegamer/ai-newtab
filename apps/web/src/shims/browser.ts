/**
 * A stand-in for the WebExtension `browser` global, so the extension's own modules
 * (storage, sources, archive, uiPrefs, useLatest) run in a page unchanged.
 *
 * Only what the shared UI touches is here: `storage.local` over localStorage, a
 * history that is always empty (a phone page can't read the Mac's history), and
 * inert `runtime` bits.
 */

const PREFIX = "ai-newtab:";

type Changes = Record<string, { oldValue?: unknown; newValue?: unknown }>;
type ChangeListener = (changes: Changes, area: string) => void;
const listeners = new Set<ChangeListener>();

function read(key: string): unknown {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw === null ? undefined : JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function allKeys(): string[] {
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(PREFIX)) keys.push(k.slice(PREFIX.length));
  }
  return keys;
}

function notify(changes: Changes) {
  if (Object.keys(changes).length === 0) return;
  for (const l of listeners) l(changes, "local");
}

const local = {
  async get(keys?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    if (keys === undefined || keys === null) {
      for (const k of allKeys()) out[k] = read(k);
    } else if (typeof keys === "string") {
      const v = read(keys);
      if (v !== undefined) out[keys] = v;
    } else if (Array.isArray(keys)) {
      for (const k of keys) {
        const v = read(k);
        if (v !== undefined) out[k] = v;
      }
    } else {
      for (const [k, fallback] of Object.entries(keys)) {
        const v = read(k);
        out[k] = v === undefined ? fallback : v;
      }
    }
    return out;
  },
  async set(items: Record<string, unknown>): Promise<void> {
    const changes: Changes = {};
    for (const [k, v] of Object.entries(items)) {
      if (v === undefined) continue;
      const oldValue = read(k);
      localStorage.setItem(PREFIX + k, JSON.stringify(v));
      changes[k] = { oldValue, newValue: v };
    }
    notify(changes);
  },
  async remove(keys: string | string[]): Promise<void> {
    const changes: Changes = {};
    for (const k of Array.isArray(keys) ? keys : [keys]) {
      const oldValue = read(k);
      localStorage.removeItem(PREFIX + k);
      if (oldValue !== undefined) changes[k] = { oldValue };
    }
    notify(changes);
  },
  async clear(): Promise<void> {
    await local.remove(allKeys());
  },
};

// Another tab of the web app writing: tell this one's listeners, like chrome.storage does.
window.addEventListener("storage", (e) => {
  if (!e.key || !e.key.startsWith(PREFIX)) return;
  const key = e.key.slice(PREFIX.length);
  let newValue: unknown;
  let oldValue: unknown;
  try {
    newValue = e.newValue === null ? undefined : JSON.parse(e.newValue);
    oldValue = e.oldValue === null ? undefined : JSON.parse(e.oldValue);
  } catch {
    return;
  }
  notify({ [key]: { oldValue, newValue } });
});

const webBrowser = {
  storage: {
    local,
    onChanged: {
      addListener: (l: ChangeListener) => void listeners.add(l),
      removeListener: (l: ChangeListener) => void listeners.delete(l),
      hasListener: (l: ChangeListener) => listeners.has(l),
    },
  },
  history: {
    async search(_query: unknown): Promise<Array<{ url?: string; title?: string; lastVisitTime?: number; visitCount?: number }>> {
      return [];
    },
  },
  runtime: {
    id: "web",
    getURL: (path: string) => new URL(path, location.href).toString(),
    async getPlatformInfo() {
      return { os: "web", arch: "web" };
    },
    onMessage: { addListener() {}, removeListener() {} },
  },
};

export type WebBrowser = typeof webBrowser;

(globalThis as unknown as { browser: WebBrowser }).browser = webBrowser;
