import {
  addKnownIfMissing,
  migrateRetiredFeeds,
  seedCatalog,
  type SeedResult,
  type FeedSource,
} from "@homepage/agent-core";
import { createArchiveBridge } from "./archive";
import { getHistorySites } from "./history";
import { KEYS, loadSettings } from "./storage";

/**
 * The user's catalog of news sources, stored in chrome.storage.local. The table of
 * publications we know feeds for, and the pure seeding and editing helpers, live in
 * agent-core (`feed-catalog.ts`) so the harness reads the same ones.
 */
export {
  DEFAULT_FEEDS,
  addFeedUrl,
  isSourceBlocked,
  mergeSeeded,
  seedCatalog,
  seedSources,
  type KnownSource,
  type SeedResult,
} from "@homepage/agent-core";

/** Domains the person actually visits (at least a few times in the last two months). */
async function frequentHistoryDomains(): Promise<string[]> {
  try {
    const { sites } = await getHistorySites(60, 0);
    return sites.filter((s) => s.totalVisits >= 3).map((s) => s.domain);
  } catch {
    return [];
  }
}

/**
 * Seeds from the archive at `archiveUrl` (empty string: history only) plus
 * browsing history. `archiveError` is set when the archive was configured but
 * could not be read.
 */
export async function seedFromArchive(archiveUrl: string): Promise<SeedResult & { archiveError?: string }> {
  let archive: Array<{ site: string; count: number }> = [];
  let archiveError: string | undefined;
  if (archiveUrl.trim() !== "") {
    try {
      const list = await createArchiveBridge(archiveUrl).listArticles({ sinceDays: 365, limit: 1 });
      archive = list.sources;
    } catch (err) {
      archiveError = err instanceof Error ? err.message : String(err);
    }
  }
  const history = await frequentHistoryDomains();
  return { ...seedCatalog(archive, history), archiveError };
}


/** Drops anything in `raw` that isn't shaped like a source, so a bad stored value can't break the UI. */
function sanitize(raw: unknown): FeedSource[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: FeedSource[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const { id, name, feedUrls, enabled } = entry as Partial<FeedSource>;
    if (typeof id !== "string" || !id || typeof name !== "string" || !name || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name,
      feedUrls: Array.isArray(feedUrls) ? feedUrls.filter((u): u is string => typeof u === "string") : [],
      enabled: enabled !== false,
    });
  }
  return out;
}

/** The version of the one-time migrations below. 1: Reuters, offered once to catalogs seeded before it was known. */
const MIGRATION_VERSION = 1;

async function readStored(): Promise<FeedSource[] | null> {
  const stored = (await browser.storage.local.get(KEYS.sources))[KEYS.sources];
  return Array.isArray(stored) ? sanitize(stored) : null;
}

/**
 * Brings a stored catalog up to date, and stores it only if that changed something:
 *
 * - a source still on a feed list an earlier version shipped (WSJ's frozen
 *   `feeds.a.dj.com` address) gets the current default feeds, every load, since
 *   it costs nothing; a list the person edited is left as it is;
 * - Reuters, which had no feed until its news sitemap was supported, is appended
 *   once if the archive (or browsing history) says the person reads it and no
 *   source of the catalog covers reuters.com. "Once" is `sourcesMigrated`: a
 *   person who removes it later is not given it again. It is settled only when
 *   the archive could be asked (or was off) or it answered yes, so an archive
 *   that is down is asked again next time and never costs a write.
 */
async function migrateStored(current: FeedSource[], done: boolean): Promise<FeedSource[]> {
  let wantsReuters = false;
  let settled = done;
  if (!done) {
    const { archiveUrl } = await loadSettings();
    const seeded = await seedFromArchive(archiveUrl);
    wantsReuters = seeded.sources.some((s) => s.id === "reuters");
    settled = wantsReuters || !seeded.archiveError;
  }
  // The archive can take a while: apply to what is stored now, not to what was read before it.
  const fresh = (!done ? await readStored() : null) ?? current;
  const retired = migrateRetiredFeeds(fresh);
  let sources = retired.sources;
  let changed = retired.changed;
  if (wantsReuters && sources.length > 0) {
    const withReuters = addKnownIfMissing(sources, "reuters");
    if (withReuters.added) {
      sources = withReuters.sources;
      changed = true;
    }
  }
  const write: Record<string, unknown> = {};
  if (changed) write[KEYS.sources] = sanitize(sources);
  if (settled && !done) write[KEYS.sourcesMigrated] = MIGRATION_VERSION;
  if (Object.keys(write).length > 0) await browser.storage.local.set(write);
  return sources;
}

/**
 * The stored catalog, migrated (see `migrateStored`). With nothing stored yet,
 * seeds from the archive (and history) and stores the result. When the archive was
 * configured but could not be read, or nothing was found, the seeded list is
 * returned without being stored, so the next load tries again.
 */
export async function loadSources(): Promise<FeedSource[]> {
  const got = await browser.storage.local.get([KEYS.sources, KEYS.sourcesMigrated]);
  if (Array.isArray(got[KEYS.sources])) {
    const version: unknown = got[KEYS.sourcesMigrated];
    const done = typeof version === "number" && version >= MIGRATION_VERSION;
    return migrateStored(sanitize(got[KEYS.sources]), done);
  }

  const { archiveUrl } = await loadSettings();
  const { sources, archiveError } = await seedFromArchive(archiveUrl);
  // A catalog seeded while the archive couldn't be read is only the history part of it;
  // storing that would freeze it. Show it, don't keep it, and try again next time.
  if (sources.length > 0 && !archiveError) {
    await browser.storage.local.set({
      [KEYS.sources]: sanitize(sources),
      [KEYS.sourcesMigrated]: MIGRATION_VERSION,
    });
  }
  return sources;
}

export async function saveSources(sources: FeedSource[]): Promise<void> {
  await browser.storage.local.set({ [KEYS.sources]: sanitize(sources) });
}

