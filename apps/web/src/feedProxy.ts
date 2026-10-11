/**
 * Cross-origin feed fetches go through Amber's `/api/feedproxy?url=`: a page can't read
 * a publisher's feed itself (no CORS), and the extension's host permissions don't exist here.
 * agent-core's feed code keeps calling plain `fetch`; this wraps `window.fetch` once.
 *
 * Only GET requests to another http(s) origin are rerouted. Same-origin calls (Amber's own
 * API) pass straight through. The proxy's response is handed back looking like the feed's
 * own: `url` is the address that was asked for, so agent-core's private-redirect check
 * reads the publisher's host and not Amber's.
 */
export const FEED_PROXY_PATH = "/api/feedproxy";

export function proxiedUrl(address: string, origin = location.origin): string {
  return `${origin}${FEED_PROXY_PATH}?url=${encodeURIComponent(address)}`;
}

export function installFeedProxy(): void {
  const nativeFetch = window.fetch.bind(window);

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : null;
    const address = request ? request.url : String(input);
    const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
    let target: URL | null = null;
    try {
      target = new URL(address, location.href);
    } catch {
      /* not an address: let fetch report it */
    }
    if (!target || method !== "GET" || !/^https?:$/.test(target.protocol) || target.origin === location.origin) {
      return nativeFetch(input, init);
    }

    const signal = init?.signal ?? request?.signal ?? undefined;
    const headers = new Headers(init?.headers ?? request?.headers);
    const forwarded: Record<string, string> = {};
    const accept = headers.get("Accept");
    if (accept) forwarded.Accept = accept;
    const response = await nativeFetch(proxiedUrl(target.href), {
      method: "GET",
      credentials: "omit",
      headers: forwarded,
      signal,
    });
    Object.defineProperty(response, "url", { value: target.href });
    return response;
  };
}
