import { normalizeArchiveUrl } from "@homepage/agent-core";

/** Read-only amber-reader. Used when the Mac archive doesn't answer. */
export const DEFAULT_FALLBACK_ARCHIVE_URL = "https://dell-plx-reader.tailf9612a.ts.net";

/**
 * Exact retired defaults, and the migration version that rewrites each one.
 * `http://dell-plx:8081` and `http://dell-plx-reader:8081` were unreleased
 * intermediate defaults. A stored version below `version` still rewrites that
 * address; a later choice of it, after that version is stored, is kept.
 */
export const RETIRED_FALLBACK_ARCHIVE_URLS = [
  { url: "http://boxj:8081", version: 2 },
  { url: "http://dell-plx:8081", version: 2 },
  { url: "http://dell-plx-reader:8081", version: 2 },
] as const;

/** Highest fallback-host migration applied. Raising it is what runs the next rewrite. */
export const FALLBACK_ARCHIVE_MIGRATION_VERSION = 2;

export interface FallbackArchiveMigration {
  url: string;
  /** The stored address itself must be replaced. */
  changed: boolean;
  /** The migration version is not stored yet and must be written. */
  recordVersion: boolean;
}

/**
 * The fallback address to use. Missing means the current default and is not a
 * stored change. Each retired address is rewritten once, when the stored
 * version is below the version that retires it. After the current version is
 * stored, those addresses stay, including when someone chooses one on purpose.
 * Any other value, including "" (failover off), stays.
 */
export function migrateFallbackArchiveUrl(
  stored: string | undefined,
  migratedVersion: number | undefined,
): FallbackArchiveMigration {
  const seen = typeof migratedVersion === "number" ? migratedVersion : 0;
  const url = stored === undefined ? DEFAULT_FALLBACK_ARCHIVE_URL : stored;
  // One comparison against the current version. Each retired address carries its own.
  if (seen >= FALLBACK_ARCHIVE_MIGRATION_VERSION) return { url, changed: false, recordVersion: false };
  const retired =
    stored !== undefined && RETIRED_FALLBACK_ARCHIVE_URLS.some((item) => item.url === stored && seen < item.version);
  if (retired) return { url: DEFAULT_FALLBACK_ARCHIVE_URL, changed: true, recordVersion: true };
  return { url, changed: false, recordVersion: true };
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
