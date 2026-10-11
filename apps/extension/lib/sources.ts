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
/** An unsettled migration is tried at most this often (the archive may be down, or its address wrong). */
const MIGRATION_RETRY_MS = 60 * 60_000;

interface CatalogState {
  stored: FeedSource[] | null;
  /** The one-time migrations have been decided: the person's list is theirs from here on. */
  done: boolean;
  triedAt: number;
}

/** The stored list and the migration markers, read together so they agree with each other. */
async function readState(): Promise<CatalogState> {
  const got = await browser.storage.local.get([KEYS.sources, KEYS.sourcesMigrated, KEYS.sourcesMigrationTriedAt]);
  const version: unknown = got[KEYS.sourcesMigrated];
  const tried: unknown = got[KEYS.sourcesMigrationTriedAt];
  return {
    stored: Array.isArray(got[KEYS.sources]) ? sanitize(got[KEYS.sources]) : null,
    done: typeof version === "number" && version >= MIGRATION_VERSION,
    triedAt: typeof tried === "number" ? tried : 0,
  };
}

let offering: Promise<void> | null = null;

/**
 * Offers Reuters once to a catalog that was seeded before it had a feed: appended,
 * enabled, if the archive (or browsing history) says the person reads it and no
 * source covers reuters.com. Runs in the background, never ahead of Latest: the
 * archive may be unreachable (10 s) and the list is already on its way to the screen.
 *
 * "Once" is `sourcesMigrated`, which `saveSources` also sets, so a person who removes
 * Reuters (or saves any list of their own) is not given it again. The list and the
 * flag are read again right before deciding, after the archive has answered, so a
 * save made meanwhile wins. Browsing history is looked at first and settles it by
 * itself; otherwise the archive is asked, and it is settled when that could be done
 * (or the archive was off) or it said yes. A try that is not settled, or whose page
 * was closed first, waits an hour (`sourcesMigrationTriedAt`). Never throws.
 */
async function offerReuters(): Promise<void> {
  const reutersIn = (list: FeedSource[]) => list.some((s) => s.id === "reuters");
  /** Decide on what is stored now, which may have changed while the archive was being asked. */
  const decide = async (wantsReuters: boolean, settled: boolean) => {
    const now = await readState();
    if (now.done) return;
    const write: Record<string, unknown> = {};
    if (wantsReuters && now.stored && now.stored.length > 0) {
      const withReuters = addKnownIfMissing(migrateRetiredFeeds(now.stored).sources, "reuters");
      if (withReuters.added) write[KEYS.sources] = sanitize(withReuters.sources);
    }
    if (settled) write[KEYS.sourcesMigrated] = MIGRATION_VERSION;
    if (Object.keys(write).length > 0) await browser.storage.local.set(write);
  };
  try {
    await browser.storage.local.set({ [KEYS.sourcesMigrationTriedAt]: Date.now() });
    // Browsing history answers at once; only without its say-so is the archive asked.
    if (reutersIn(seedCatalog([], await frequentHistoryDomains()).sources)) return await decide(true, true);
    const { archiveUrl } = await loadSettings();
    const seeded = await seedFromArchive(archiveUrl);
    const wantsReuters = reutersIn(seeded.sources);
    await decide(wantsReuters, wantsReuters || !seeded.archiveError);
  } catch {
    /* tried again in an hour */
  }
}

/**
 * The stored catalog, handed back at once. With nothing stored yet, seeds from the
 * archive (and history) and stores the result; when the archive was configured but
 * could not be read, or nothing was found, the seeded list is returned without being
 * stored, so the next load tries again.
 *
 * A stored list is brought up to date on the way out:
 *
 * - a source still on a feed list an earlier version shipped (WSJ's frozen
 *   `feeds.a.dj.com` address) gets the current default feeds, on every load, since
 *   it costs nothing; a list the person edited is left as it is;
 * - Reuters is offered once, in the background (`offerReuters`).
 */
export async function loadSources(): Promise<FeedSource[]> {
  const state = await readState();
  if (state.stored) {
    let sources = state.stored;
    const retired = migrateRetiredFeeds(sources);
    if (retired.changed) {
      sources = retired.sources;
      try {
        await browser.storage.local.set({ [KEYS.sources]: sanitize(sources) });
      } catch {
        /* shown migrated anyway; stored on a later load */
      }
    }
    if (!state.done && !offering && Date.now() - state.triedAt >= MIGRATION_RETRY_MS) {
      offering = offerReuters().finally(() => {
        offering = null;
      });
    }
    return sources;
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

/** Stores the person's list. Saving it settles the one-time migrations: what is in it is their choice. */
export async function saveSources(sources: FeedSource[]): Promise<void> {
  await browser.storage.local.set({
    [KEYS.sources]: sanitize(sources),
    [KEYS.sourcesMigrated]: MIGRATION_VERSION,
  });
}
