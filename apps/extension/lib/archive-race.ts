import { anySignal, normalizeArchiveUrl } from "@homepage/agent-core";
import { archiveGetInit, type ArchiveAuth } from "./archive-auth";

/** After a Mac win, later reads call only the Mac. */
export const MAC_UP_MS = 2 * 60 * 1000;
/** After a Mac timeout or network error, later reads call only the fallback. */
export const MAC_DOWN_MS = 5 * 60 * 1000;
/** How long a cold read waits for Mac response headers before starting the fallback. */
export const FALLBACK_DELAY_MS = 1_500;

export interface OriginCache {
  /** Epoch ms. While this is in the future, call only the Mac. */
  upUntil: number | null;
  /** Epoch ms. While this is in the future, call only the fallback. */
  downUntil: number | null;
}

export function createOriginCache(): OriginCache {
  return { upUntil: null, downUntil: null };
}

export interface RaceSuccess {
  origin: "mac" | "fallback";
  /** Normalized base the JSON was read from. Permalinks and text use this. */
  base: string;
  json: unknown;
}

export interface RaceOptions {
  macBase: string;
  /** Null, empty, or not an address: call only the Mac. */
  fallbackBase: string | null;
  password: string;
  /** Path beginning with `/`, appended to whichever base wins. */
  path: string;
  /** Mac limit (and the fallback's own limit, starting when the fallback starts). */
  timeoutMs: number;
  signal?: AbortSignal;
  cache: OriginCache;
  now?: () => number;
  fetchImpl?: typeof fetch;
  /** Called after every cache write, including a Mac win that arrives after the fallback. */
  onCache?: () => void;
}

type FetchResult =
  | { kind: "usable"; json: unknown }
  | { kind: "status"; status: number }
  | { kind: "network" }
  | { kind: "timeout" }
  | { kind: "aborted" };

function join(base: string, path: string): string {
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

function withTimeout(ms: number): { signal: AbortSignal; cancel: () => void; timedOut: () => boolean } {
  const controller = new AbortController();
  let didTimeout = false;
  const timer = setTimeout(() => {
    didTimeout = true;
    controller.abort();
  }, ms);
  return {
    signal: controller.signal,
    timedOut: () => didTimeout,
    cancel: () => clearTimeout(timer),
  };
}

/**
 * One GET. `fetch` resolves when response headers arrive; the body is read after
 * `onHeaders`, so a slow body is not "no headers yet".
 */
async function runFetch(
  url: string,
  timeoutMs: number,
  fetchImpl: typeof fetch,
  auth: ArchiveAuth,
  caller: AbortSignal | undefined,
  localAbort: AbortSignal | undefined,
  onHeaders?: () => void,
): Promise<FetchResult> {
  const timeout = withTimeout(timeoutMs);
  const signals = [timeout.signal];
  if (caller) signals.push(caller);
  if (localAbort) signals.push(localAbort);
  const stop = anySignal(signals);
  try {
    const response = await fetchImpl(url, {
      ...archiveGetInit(url, auth),
      signal: stop,
    });
    onHeaders?.();
    if (caller?.aborted || localAbort?.aborted) return { kind: "aborted" };
    if (!response.ok) return { kind: "status", status: response.status };
    try {
      const json = (await readJson(response, stop)) as unknown;
      if (caller?.aborted || localAbort?.aborted) return { kind: "aborted" };
      if (json !== null && typeof json === "object") return { kind: "usable", json };
      return { kind: "status", status: response.status };
    } catch (err) {
      if (caller?.aborted || localAbort?.aborted) return { kind: "aborted" };
      if (timeout.timedOut()) return { kind: "timeout" };
      if (err instanceof SyntaxError) return { kind: "status", status: response.status };
      throw err;
    }
  } catch {
    if (caller?.aborted || localAbort?.aborted) return { kind: "aborted" };
    if (timeout.timedOut()) return { kind: "timeout" };
    return { kind: "network" };
  } finally {
    timeout.cancel();
  }
}

function abortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

/**
 * `response.json()` does not watch the fetch signal. Tie the body read to it so
 * the Mac's 10s (and the fallback's own) limit still ends a slow body.
 */
function readJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const body = response.json();
  if (signal.aborted) {
    void body.catch(() => {});
    return Promise.reject(abortError());
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort);
    body.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        if (signal.aborted) reject(abortError());
        else resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        if (signal.aborted) reject(abortError());
        else reject(err);
      },
    );
  });
}

function describe(result: FetchResult, url: string): Error {
  if (result.kind === "status") return new Error(`archive responded ${result.status} for ${url}`);
  if (result.kind === "timeout") return new Error(`archive timed out for ${url}`);
  if (result.kind === "aborted") return new DOMException("The operation was aborted.", "AbortError");
  return new Error(`archive unreachable for ${url}`);
}

function isTerminalAnswer(result: FetchResult): result is { kind: "status"; status: number } {
  return result.kind === "status" && (result.status === 401 || result.status === 404);
}

/**
 * Read one archive JSON document from the Mac, failing over to the reader.
 *
 * Cold cache: the Mac is called immediately. The fallback starts only after 1.5s
 * with no Mac response headers (or immediately on a Mac network error / timeout).
 * The first usable JSON is what the caller receives, and the fallback is aborted
 * if the Mac wins. A Mac 401 or 404 is the answer: the fallback is not used.
 * A Mac body that arrives after the fallback has already won refreshes the cache
 * and is not returned. The caller keeps the list it already has.
 */
export async function raceArchiveJson(opts: RaceOptions): Promise<RaceSuccess> {
  const now = opts.now ?? Date.now;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const t = now();
  let changed = false;
  if (opts.cache.upUntil !== null && t >= opts.cache.upUntil) {
    opts.cache.upUntil = null;
    changed = true;
  }
  if (opts.cache.downUntil !== null && t >= opts.cache.downUntil) {
    opts.cache.downUntil = null;
    changed = true;
  }
  if (changed) opts.onCache?.();

  const macBase = normalizeArchiveUrl(opts.macBase);
  if (!macBase) throw new Error("Invalid archive URL");
  // A fresh binding, so the closures below see `string` rather than a narrowed `string | null`.
  const mac: string = macBase;
  const fallback = opts.fallbackBase?.trim() ? normalizeArchiveUrl(opts.fallbackBase) : null;
  const auth: ArchiveAuth = { macBase: mac, fallbackBase: fallback ?? "", password: opts.password };
  const macUrl = join(mac, opts.path);

  const markUp = () => {
    opts.cache.upUntil = now() + MAC_UP_MS;
    opts.cache.downUntil = null;
    opts.onCache?.();
  };
  const markDown = () => {
    opts.cache.downUntil = now() + MAC_DOWN_MS;
    opts.cache.upUntil = null;
    opts.onCache?.();
  };

  const one = async (origin: "mac" | "fallback", base: string): Promise<RaceSuccess> => {
    const url = join(base, opts.path);
    const result = await runFetch(url, opts.timeoutMs, fetchImpl, auth, opts.signal, undefined);
    if (result.kind === "usable") {
      if (origin === "mac") markUp();
      return { origin, base, json: result.json };
    }
    if (origin === "mac" && (result.kind === "timeout" || result.kind === "network")) markDown();
    throw describe(result, url);
  };

  if (opts.cache.upUntil !== null && t < opts.cache.upUntil) return one("mac", mac);
  if (fallback && opts.cache.downUntil !== null && t < opts.cache.downUntil) return one("fallback", fallback);
  if (!fallback) return one("mac", mac);
  const box: string = fallback;

  const boxUrl = join(box, opts.path);
  return new Promise((resolve, reject) => {
    let settled = false;
    let headersSeen = false;
    let boxStarted = false;
    let macResult: FetchResult | null = null;
    let boxResult: FetchResult | null = null;
    let boxAbort: AbortController | null = null;
    let headerTimer: ReturnType<typeof setTimeout> | undefined;

    const clearHeaderTimer = () => {
      if (headerTimer !== undefined) {
        clearTimeout(headerTimer);
        headerTimer = undefined;
      }
    };
    let onCallerAbort: () => void = () => {};
    const stopCaller = () => opts.signal?.removeEventListener("abort", onCallerAbort);
    const finishOk = (value: RaceSuccess) => {
      if (settled) return;
      settled = true;
      clearHeaderTimer();
      stopCaller();
      resolve(value);
    };
    const finishErr = (err: Error) => {
      if (settled) return;
      settled = true;
      clearHeaderTimer();
      stopCaller();
      reject(err);
    };
    const abortBox = () => boxAbort?.abort();
    onCallerAbort = () => {
      // The Mac may already have failed and the fallback fetch may ignore the
      // signal. Cancel still has to reject; waiting on that fetch would hang.
      abortBox();
      if (!settled) finishErr(describe({ kind: "aborted" }, macUrl));
    };

    const startBox = () => {
      if (boxStarted || settled) return;
      boxStarted = true;
      boxAbort = new AbortController();
      void runFetch(boxUrl, opts.timeoutMs, fetchImpl, auth, opts.signal, boxAbort.signal).then(
        handleBox,
        () => handleBox({ kind: "network" }),
      );
    };

    const failIfBothDone = () => {
      if (settled || !macResult || isTerminalAnswer(macResult)) return;
      if (!boxStarted) {
        startBox();
        return;
      }
      // A usable fallback already resolved. An aborted one is finished too, so a
      // Mac that has already failed rejects here instead of waiting for a body.
      if (!boxResult || boxResult.kind === "usable") return;
      if (boxResult.kind === "aborted" && opts.signal?.aborted) {
        finishErr(describe(boxResult, boxUrl));
        return;
      }
      const error = boxResult.kind === "status" ? describe(boxResult, boxUrl) : describe(macResult, macUrl);
      finishErr(error);
    };

    function handleBox(result: FetchResult) {
      boxResult = result;
      if (result.kind === "usable") {
        // The Mac request is left running. A later usable body refreshes the cache
        // and must not replace the list this resolution already handed back.
        if (!settled) finishOk({ origin: "fallback", base: box, json: result.json });
        return;
      }
      if (!settled) failIfBothDone();
    }

    function handleMac(result: FetchResult) {
      clearHeaderTimer();
      if (result.kind === "aborted") {
        abortBox();
        if (!settled) finishErr(describe(result, macUrl));
        return;
      }
      if (result.kind === "usable") {
        markUp();
        if (!settled) {
          abortBox();
          finishOk({ origin: "mac", base: mac, json: result.json });
        }
        return;
      }
      if (result.kind === "timeout" || result.kind === "network") markDown();
      macResult = result;
      if (settled) return;
      if (isTerminalAnswer(result)) {
        abortBox();
        finishErr(describe(result, macUrl));
        return;
      }
      failIfBothDone();
    }

    if (opts.signal?.aborted) {
      finishErr(describe({ kind: "aborted" }, macUrl));
      return;
    }
    opts.signal?.addEventListener("abort", onCallerAbort);

    headerTimer = setTimeout(() => {
      if (!headersSeen && !settled) startBox();
    }, FALLBACK_DELAY_MS);

    void runFetch(macUrl, opts.timeoutMs, fetchImpl, auth, opts.signal, undefined, () => {
      headersSeen = true;
      clearHeaderTimer();
    }).then(handleMac, () => handleMac({ kind: "network" }));
  });
}
