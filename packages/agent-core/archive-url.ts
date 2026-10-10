/**
 * The one place an archive address is cleaned up. Returns the base URL without a
 * trailing slash, or null when the input can't be an Amber address. Adds
 * `http://` when no scheme was typed; rejects other schemes, credentials, a query
 * and a fragment. Empty input is null too: callers check for "" first, since an
 * empty address means the archive is switched off rather than mistyped.
 */
export function normalizeArchiveUrl(input: string): string | null {
  const text = input.trim();
  if (!text || /\s/.test(text) || /[?#]/.test(text)) return null;
  // `http:/host` is a mistyped scheme, not a host called "http".
  if (/^https?:/i.test(text) && !/^https?:\/\//i.test(text)) return null;
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password || !url.hostname) return null;
  return `${url.protocol}//${url.host}${url.pathname}`.replace(/\/+$/, "");
}

/** The hostname of a normalized-able archive address, or null when it isn't one. */
export function archiveHostOf(input: string): string | null {
  const base = normalizeArchiveUrl(input);
  return base ? new URL(base).hostname : null;
}
