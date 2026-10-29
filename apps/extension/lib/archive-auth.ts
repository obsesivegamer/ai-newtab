import { normalizeArchiveUrl } from "@homepage/agent-core";

/** Read-only amber-reader. Used when the Mac archive doesn't answer. */
export const DEFAULT_FALLBACK_ARCHIVE_URL = "http://dell-plx-reader:8081";

/**
 * Exact retired defaults. Each is rewritten once, to the current default.
 * `http://dell-plx:8081` was an unreleased intermediate default.
 */
export const RETIRED_FALLBACK_ARCHIVE_URLS = ["http://boxj:8081", "http://dell-plx:8081"] as const;

/** Stored once this fallback-host migration has run, so a later choice of a retired address is kept. */
export const FALLBACK_ARCHIVE_MIGRATION_VERSION = 1;

export interface FallbackArchiveMigration {
  url: string;
  /** The stored address itself must be replaced. */
  changed: boolean;
  /** The migration version is not stored yet and must be written. */
  recordVersion: boolean;
}

/**
 * The fallback address to use. Missing means the current default and is not a
 * stored change. The first time this runs, an exact retired default moves to
 * the current one and the migration version is recorded. After that version is
 * stored, those addresses stay, including when someone chooses one on purpose.
 * Any other value, including "" (failover off), stays.
 */
export function migrateFallbackArchiveUrl(
  stored: string | undefined,
  migratedVersion: number | undefined,
): FallbackArchiveMigration {
  const done =
    typeof migratedVersion === "number" &&
    Number.isFinite(migratedVersion) &&
    migratedVersion >= FALLBACK_ARCHIVE_MIGRATION_VERSION;
  const url = stored === undefined ? DEFAULT_FALLBACK_ARCHIVE_URL : stored;
  if (done) return { url, changed: false, recordVersion: false };
  const retired = stored !== undefined && (RETIRED_FALLBACK_ARCHIVE_URLS as readonly string[]).includes(stored);
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
