import { normalizeArchiveUrl } from "@homepage/agent-core";

/** Read-only amber-reader. Used when the Mac archive doesn't answer. */
export const DEFAULT_FALLBACK_ARCHIVE_URL = "http://dell-plx:8081";

/** The previous default. A stored copy of this exact address is rewritten to the current default. */
export const RETIRED_FALLBACK_ARCHIVE_URL = "http://boxj:8081";

/**
 * The fallback address to use for `stored`. Missing means the current default.
 * The retired default moves to the current one. Any other value, including ""
 * (failover off), stays.
 */
export function migrateFallbackArchiveUrl(stored: string | undefined): { url: string; changed: boolean } {
  if (stored === RETIRED_FALLBACK_ARCHIVE_URL) return { url: DEFAULT_FALLBACK_ARCHIVE_URL, changed: true };
  if (stored === undefined) return { url: DEFAULT_FALLBACK_ARCHIVE_URL, changed: false };
  return { url: stored, changed: false };
}

/** HTTP Basic user amber-reader expects. The password is the reader's. */
export const READER_BASIC_USER = "amber";

/**
 * Which archive a request may authenticate to. `macBase` is the configured Mac
 * archive; requests to that origin never carry Authorization, even if it is also
 * the fallback. `fallbackBase` is "" when the fallback is turned off.
 */
export interface ArchiveAuth {
  macBase: string;
  fallbackBase: string;
  password: string;
}

/** `Authorization` value for amber-reader. UTF-8 passwords survive `btoa`. */
export function basicAuthorization(user: string, password: string): string {
  const bytes = new TextEncoder().encode(`${user}:${password}`);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `Basic ${btoa(binary)}`;
}

function originOf(base: string): string | null {
  try {
    return new URL(base).origin;
  } catch {
    return null;
  }
}

/**
 * Authorization for one archive GET, or undefined when the request must not
 * carry one. Only the fallback origin gets HTTP Basic (user "amber"). The Mac
 * origin never does.
 */
export function authorizationFor(url: string, auth: ArchiveAuth | undefined): string | undefined {
  if (!auth?.fallbackBase) return undefined;
  const target = originOf(url);
  const fallback = originOf(auth.fallbackBase);
  const mac = originOf(auth.macBase);
  if (!target || !fallback || target !== fallback || target === mac) return undefined;
  return basicAuthorization(READER_BASIC_USER, auth.password);
}

/** Headers for an archive GET. Undefined when no Authorization may be sent. */
export function archiveRequestHeaders(url: string, auth: ArchiveAuth | undefined): Headers | undefined {
  const authorization = authorizationFor(url, auth);
  if (!authorization) return undefined;
  return new Headers({ Authorization: authorization });
}

/**
 * Options for an archive GET. A request that carries the reader password refuses
 * redirects, so the password cannot be sent on to another host.
 */
export function archiveGetInit(url: string, auth: ArchiveAuth | undefined): RequestInit {
  const headers = archiveRequestHeaders(url, auth);
  if (!headers) return {};
  return { headers, redirect: "error" };
}

/** A cleaned fallback base, or null when it is off or not an address. */
export function fallbackBaseOf(input: string | null | undefined): string | null {
  const text = input?.trim() ?? "";
  if (!text) return null;
  return normalizeArchiveUrl(text);
}
