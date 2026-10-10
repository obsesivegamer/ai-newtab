import type Anthropic from "@anthropic-ai/sdk";
import { buildHistoryDigest, slugifyUrl } from "./history-digest";
import { OUTPUT_PATH, buildKickoffMessage } from "./prompt";
import {
  DEFAULT_BLOCKED_SITES,
  hostOf,
  isAllowedUrl,
  isBlocked,
  isSameOrSubdomain,
  normalizeBlockList,
} from "./site-filter";
import { DEFAULTS } from "./schemas";
import { STORAGE_KEYS, ensureAgent, ensureEnvironment, type HomepageModel } from "./setup";
import type {
  ArchiveArticle,
  ArchiveBridge,
  ArchiveRef,
  BrowserBridge,
  GetArchiveArticlesResult,
  GetArchiveResult,
  GetHistoryResult,
  GetPageHtmlResult,
  HomepageBuildResult,
  KVStore,
  PageRef,
  RunCallbacks,
  RunPhase,
} from "./types";

type SessionEvent = Anthropic.Beta.Sessions.BetaManagedAgentsSessionEvent;
type CustomToolUse = Anthropic.Beta.Sessions.BetaManagedAgentsAgentCustomToolUseEvent;

/** Callbacks with the optionality resolved, so call sites don't repeat `?.`. */
interface Emit {
  phase(phase: RunPhase, detail?: string): void;
  text(chunk: string): void;
  log(line: string): void;
}

const MANAGED_AGENTS_BETA = "managed-agents-2026-04-01";

/** Files mount under this root no matter what path you ask for. Ask for it directly. */
const UPLOAD_ROOT = "/mnt/session/uploads";

export interface RunOptions {
  client: Anthropic;
  bridge: BrowserBridge;
  /** The user's saved-article archive. Without it the archive tools answer with an error. */
  archive?: ArchiveBridge;
  store: KVStore;
  userSystemPrompt?: string;
  /**
   * Hosts the tools must never read. A getter is re-read before every tool call,
   * so a list saved mid-build applies to the rest of that build.
   */
  blockedSites?: string[] | (() => Promise<string[]>);
  /** Ignored when resuming: the session keeps the agent (and model) it started with. */
  model?: HomepageModel;
  callbacks?: RunCallbacks;
  signal?: AbortSignal;
  /** Reattach to an existing session instead of creating one (e.g. after the host was killed mid-run). */
  resumeSessionId?: string;
  now?: Date;
}

export async function runHomepageBuild(opts: RunOptions): Promise<HomepageBuildResult> {
  const { client, bridge, archive, store, callbacks, signal } = opts;
  const emit: Emit = {
    phase: (p, d) => callbacks?.onPhase?.(p, d),
    text: (t) => callbacks?.onText?.(t),
    log: (l) => callbacks?.onLog?.(l),
  };

  emit.phase("setup");
  const [agentId, environmentId] = await Promise.all([
    ensureAgent(client, store, opts.model),
    ensureEnvironment(client, store),
  ]);
  emit.log(`agent=${agentId} environment=${environmentId}`);

  let sessionId = opts.resumeSessionId;
  if (!sessionId) {
    emit.phase("session-create");
    const session = await client.beta.sessions.create({
      agent: agentId,
      environment_id: environmentId,
      title: `Homepage ${(opts.now ?? new Date()).toISOString().slice(0, 10)}`,
    });
    sessionId = session.id;
    await store.set(STORAGE_KEYS.activeSessionId, sessionId);
  }
  emit.log(`session=${sessionId}`);

  // Persist upload IDs so cleanup can still find them after a reattach.
  const uploadedFileIds: string[] =
    (await store.get<string[]>(STORAGE_KEYS.uploadedFileIds)) ?? [];
  const rememberUpload = async (id: string) => {
    uploadedFileIds.push(id);
    await store.set(STORAGE_KEYS.uploadedFileIds, uploadedFileIds);
  };

  // Archive articles already mounted this run, so a repeat request reuses the file.
  const mountedArchive = new Map<string, ArchiveRef>();

  // Hosts the model has been shown this run (history digest, archive originalUrls).
  // getPageHtml may only load these: a name from a scraped page or an archived
  // article must not be able to steer the signed-in browser somewhere new.
  // Persisted like upload ids so a re-answered call after a reattach still has them.
  const savedHosts = opts.resumeSessionId
    ? await store.get<string[]>(STORAGE_KEYS.seenHosts)
    : undefined;
  const seenHosts = new Set<string>(Array.isArray(savedHosts) ? savedHosts : []);
  const rememberHosts = async (values: string[]) => {
    const before = seenHosts.size;
    for (const value of values) {
      const host = hostOf(value);
      if (host) seenHosts.add(host);
    }
    if (seenHosts.size !== before) await store.set(STORAGE_KEYS.seenHosts, [...seenHosts]);
  };

  let finalMessage = "";

  /**
   * Every path out of here must send a result. An `agent.custom_tool_use` that
   * never receives one leaves the session idle forever — the single
   * unrecoverable bug in this design.
   */
  const dispatch = async (event: CustomToolUse): Promise<void> => {
    try {
      const blockedSites = normalizeBlockList(
        (typeof opts.blockedSites === "function" ? await opts.blockedSites() : opts.blockedSites) ?? DEFAULT_BLOCKED_SITES,
      );
      let result: GetHistoryResult | GetPageHtmlResult | GetArchiveResult | GetArchiveArticlesResult;
      switch (event.name) {
        case "getArchive":
          result = await runGetArchive(event, archive, emit, blockedSites);
          await rememberHosts(result.articles.map((a) => a.originalUrl));
          break;
        case "getArchiveArticles":
          result = await runGetArchiveArticles(event, {
            client,
            archive,
            sessionId: sessionId!,
            rememberUpload,
            mounted: mountedArchive,
            emit,
            blockedSites,
          });
          break;
        case "getHistory":
          result = await runGetHistory(event, bridge, emit, blockedSites);
          await rememberHosts(result.sites.map((site) => site.domain));
          break;
        case "getPageHtml":
          result = await runGetPageHtml(event, {
            client,
            bridge,
            sessionId: sessionId!,
            rememberUpload,
            emit,
            blockedSites,
            seenHosts,
          });
          break;
        default:
          throw new Error(`Unknown custom tool: ${event.name}`);
      }

      await client.beta.sessions.events.send(sessionId!, {
        events: [
          {
            type: "user.custom_tool_result",
            custom_tool_use_id: event.id,
            content: [{ type: "text", text: JSON.stringify(result) }],
          },
        ],
      });
    } catch (err) {
      emit.log(`tool ${event.name} failed: ${String(err)}`);
      await client.beta.sessions.events.send(sessionId!, {
        events: [
          {
            type: "user.custom_tool_result",
            custom_tool_use_id: event.id,
            is_error: true,
            content: [{ type: "text", text: String(err) }],
          },
        ],
      });
    }
  };

  const observe = (event: SessionEvent) => {
    switch (event.type) {
      case "agent.message":
        for (const block of event.content) {
          if (block.type === "text") {
            finalMessage += block.text;
            emit.text(block.text);
          }
        }
        break;
      case "agent.thinking":
        emit.phase("thinking");
        break;
      case "agent.tool_use":
        emit.phase("analyzing", event.name);
        emit.log(`sandbox:${event.name}`);
        break;
      case "session.error":
        emit.log(`session.error: ${JSON.stringify(event)}`);
        break;
    }
  };

  try {
    // ---- Open the stream BEFORE anything else. It only delivers events emitted
    // ---- after it opens; send first and the early transitions are gone.
    let stream = await client.beta.sessions.events.stream(sessionId, undefined, { signal });

    // ---- Then replay history. Covers the gap before the stream attached, and
    // ---- is what makes a reattach lossless.
    const history: SessionEvent[] = [];
    for await (const event of client.beta.sessions.events.list(sessionId)) {
      history.push(event);
    }

    const seen = new Set(history.map((e) => e.id));
    const answered = new Set(
      history
        .filter((e): e is Extract<SessionEvent, { type: "user.custom_tool_result" }> =>
          e.type === "user.custom_tool_result",
        )
        .map((e) => e.custom_tool_use_id),
    );
    const kickedOff = history.some((e) => e.type === "user.message");
    const alreadyDone = history.some(
      (e) => e.type === "session.status_idle" && e.stop_reason.type === "end_turn",
    );

    for (const event of history) observe(event);

    if (!alreadyDone) {
      // Re-answer any tool call that was left hanging when the stream dropped.
      for (const event of history) {
        if (event.type === "agent.custom_tool_use" && !answered.has(event.id)) {
          emit.log(`re-answering orphaned tool call ${event.id}`);
          await dispatch(event);
        }
      }

      if (!kickedOff) {
        await client.beta.sessions.events.send(sessionId, {
          events: [
            {
              type: "user.message",
              content: [
                {
                  type: "text",
                  text: buildKickoffMessage({
                    now: opts.now ?? new Date(),
                    userSystemPrompt: opts.userSystemPrompt,
                    archive: Boolean(archive),
                  }),
                },
              ],
            },
          ],
        });
      }

      for await (const event of stream) {
        if (signal?.aborted) throw new Error("aborted");

        // Live-preview events carry no `id` and are never terminal. They only
        // arrive if `event_deltas` was requested, but the stream union includes
        // them either way — reading `.id` off one would throw.
        if (event.type === "event_start" || event.type === "event_delta") continue;

        if (!seen.has(event.id)) {
          seen.add(event.id);
          observe(event);
          if (event.type === "agent.custom_tool_use") {
            await dispatch(event);
          }
        }

        // Terminal checks run for *every* event, including ones we've already
        // seen. `continue`-ing on a duplicate above would skip the terminal
        // event that arrived in the history fetch, and the loop would never end.
        if (event.type === "session.status_terminated") break;
        if (event.type === "session.status_idle" && event.stop_reason.type !== "requires_action") {
          emit.log(`idle: ${event.stop_reason.type}`);
          break;
        }
      }
    }

    emit.phase("writing");
    const code = await collectDeliverable(client, sessionId, finalMessage, emit);
    emit.phase("done");
    return { code: code.code, sessionId, source: code.source };
  } finally {
    // Privacy: the event log holds every domain, title and page body we sent,
    // and uploads persist independently of the session. Delete both, always.
    emit.phase("cleanup");
    await Promise.allSettled(uploadedFileIds.map((id) => client.beta.files.delete(id)));
    await store.remove(STORAGE_KEYS.uploadedFileIds);
    await store.remove(STORAGE_KEYS.seenHosts);
    if (sessionId) {
      await deleteSessionWhenSettled(client, sessionId).catch((err) =>
        emit.log(`session ${sessionId} was not deleted: ${String(err)}`),
      );
    }
    await store.remove(STORAGE_KEYS.activeSessionId);
  }
}

// ---------------------------------------------------------------------------
// tool implementations
// ---------------------------------------------------------------------------

async function runGetHistory(
  event: CustomToolUse,
  bridge: BrowserBridge,
  emit: Emit,
  blockedSites: string[],
): Promise<GetHistoryResult> {
  const input = event.input as { daysToAnalyze?: number; maxResults?: number };
  const daysToAnalyze = input.daysToAnalyze ?? DEFAULTS.daysToAnalyze;
  const maxResults = input.maxResults ?? DEFAULTS.maxResults;

  emit.phase("history", `${daysToAnalyze}d`);
  const { sites, totalSitesSeen } = await bridge.getHistory({ daysToAnalyze, maxResults });
  const allowed = sites.filter((site) => !isBlocked(site.domain, blockedSites));
  // Blocked domains are dropped from the count too: the model is never told they exist.
  const digest = buildHistoryDigest(allowed, {
    daysToAnalyze,
    maxResults,
    totalSitesSeen: totalSitesSeen - (sites.length - allowed.length),
  });
  emit.log(`history: ${digest.sites.length} of ${digest.totalSitesSeen} domains`);
  return digest;
}

async function runGetPageHtml(
  event: CustomToolUse,
  ctx: {
    client: Anthropic;
    bridge: BrowserBridge;
    sessionId: string;
    rememberUpload: (id: string) => Promise<void>;
    emit: Emit;
    blockedSites: string[];
    seenHosts: Set<string>;
  },
): Promise<GetPageHtmlResult> {
  const input = event.input as { urls: string[]; loadDelayMs?: number };
  ctx.emit.phase("scraping", `${input.urls.length} pages`);

  const allowed: string[] = [];
  const blocked: GetPageHtmlResult["failed"] = [];
  const notSeen: GetPageHtmlResult["failed"] = [];
  for (const url of input.urls) {
    // Match on the URL the browser will load; malformed URLs never reach the signed-in browser.
    if (!isAllowedUrl(url, ctx.blockedSites)) {
      blocked.push({ url, reason: "blocked by the user's settings" });
      continue;
    }
    const host = hostOf(url);
    if ([...ctx.seenHosts].some((seen) => isSameOrSubdomain(host, seen))) allowed.push(url);
    else notSeen.push({ url, reason: "not a site from your history or archive" });
  }

  // Skip the bridge entirely when nothing is left, so no scraper window opens.
  const { pages: loaded, failed } = allowed.length
    ? await ctx.bridge.getPageHtml({
        urls: allowed,
        loadDelayMs: input.loadDelayMs ?? DEFAULTS.loadDelayMs,
      })
    : { pages: [], failed: [] };

  // A redirect can land on a blocked host; drop what it read before anything is uploaded.
  const pages = loaded.filter((page) => {
    if (!page.finalUrl || isAllowedUrl(page.finalUrl, ctx.blockedSites)) return true;
    blocked.push({ url: page.url, reason: "blocked by the user's settings" });
    return false;
  });
  if (blocked.length) ctx.emit.log(`blocked: ${blocked.length} url(s)`);

  const refs: PageRef[] = [];
  const mountFailures = [...blocked, ...notSeen, ...failed];

  for (const page of pages) {
    try {
      const filename = `${slugifyUrl(page.url)}_${refs.length}.html`;
      const upload = await ctx.client.beta.files.upload({
        file: new File([page.html], filename, { type: "text/html" }),
      });
      await ctx.rememberUpload(upload.id);

      // Mount mid-session, while the session idles awaiting this very result.
      // The API re-roots every mount under /mnt/session/uploads (see below).
      const resource = await ctx.client.beta.sessions.resources.add(ctx.sessionId, {
        type: "file",
        file_id: upload.id,
        mount_path: `${UPLOAD_ROOT}/pages/${filename}`,
      });

      refs.push({
        url: page.url,
        title: page.title,
        // The API re-roots every mount under /mnt/session/uploads. Report what it
        // resolved, not what we asked for, or the model greps a path that isn't there.
        mountPath: resource.mount_path,
        bytes: page.html.length,
      });
      ctx.emit.log(`mounted ${page.url} -> ${resource.mount_path} (${page.html.length}b)`);
    } catch (err) {
      mountFailures.push({ url: page.url, reason: `mount failed: ${String(err)}` });
    }
  }

  if (refs.length === 0 && mountFailures.length > 0 && blocked.length === 0 && notSeen.length === 0) {
    throw new Error(
      `No pages could be mounted. Failures: ${mountFailures
        .map((f) => `${f.url} (${f.reason})`)
        .join("; ")}`,
    );
  }

  return { pages: refs, failed: mountFailures };
}

const ARCHIVE_UNAVAILABLE = "The article archive is unavailable";

const ARCHIVE_ID = /^[A-Za-z0-9]{3,16}$/;

/**
 * Ask the archive for this many and apply the blocked-sites list here, so blocked
 * articles don't use up `limit` and their publication can be dropped from `sources`.
 * Amber caps a page at 200, and the library holds fewer than that today; a window
 * with more than 200 usable articles would leave some blocked publications in
 * `sources` and would need paging instead.
 */
const ARCHIVE_FETCH_LIMIT = 200;

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** Keep a date only when it starts with an ISO date; free-text dates are dropped, never guessed at. */
function isoDateOrUndefined(value: string | undefined): string | undefined {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value) ? value : undefined;
}

function truncateWords(text: string, max: number): { text: string; truncated: boolean } {
  const word = /\S+/g;
  let count = 0;
  for (let m = word.exec(text); m; m = word.exec(text)) {
    if (++count > max) return { text: text.slice(0, m.index).trimEnd(), truncated: true };
  }
  return { text, truncated: false };
}

/** Header, blank line, then the body: the model greps the file and reads the top for metadata. */
function archiveFileText(article: ArchiveArticle, body: string, truncated: boolean): string {
  const header = [
    `Title: ${oneLine(article.title)}`,
    `Site: ${oneLine(article.site)}`,
    article.author ? `Author: ${oneLine(article.author)}` : undefined,
    `Published: ${isoDateOrUndefined(article.publishedAt) ?? "unknown"}`,
    `Saved: ${article.savedAt}`,
    `Permalink: ${article.permalink}`,
    `Original URL: ${article.originalUrl}`,
  ].filter(Boolean);
  const tail = truncated ? `\n\n[Truncated for analysis. Full text: ${article.permalink}]` : "";
  return `${header.join("\n")}\n\n${body}${tail}`;
}

async function runGetArchive(
  event: CustomToolUse,
  archive: ArchiveBridge | undefined,
  emit: Emit,
  blockedSites: string[],
): Promise<GetArchiveResult> {
  if (!archive) throw new Error(`${ARCHIVE_UNAVAILABLE}: none is configured for this build.`);
  const input = event.input as { sinceDays?: number; limit?: number };
  const sinceDays = clampInt(input.sinceDays, DEFAULTS.archiveSinceDays, 1, 90);
  const limit = clampInt(input.limit, DEFAULTS.archiveLimit, 1, 60);

  emit.phase("history", `archive ${sinceDays}d`);
  let listed: Awaited<ReturnType<ArchiveBridge["listArticles"]>>;
  try {
    listed = await archive.listArticles({ sinceDays, limit: ARCHIVE_FETCH_LIMIT });
  } catch (err) {
    throw new Error(`${ARCHIVE_UNAVAILABLE}: ${err instanceof Error ? err.message : String(err)}`);
  }

  // The user's blocked hosts apply to where the article came from, not to the archive's own address.
  const kept = listed.articles.filter((a) => isAllowedUrl(a.originalUrl, blockedSites));
  const dropped = listed.articles.filter((a) => !kept.includes(a));
  // As with history, blocked material is dropped from the counts too: the model is never told it exists.
  const droppedBySite = new Map<string, number>();
  for (const a of dropped) droppedBySite.set(a.site, (droppedBySite.get(a.site) ?? 0) + 1);
  const sources = listed.sources.flatMap((source) => {
    const gone = droppedBySite.get(source.site) ?? 0;
    if (!gone) return [source];
    const survivors = kept.filter((a) => a.site === source.site);
    const count = source.count - gone;
    if (count <= 0 || survivors.length === 0) return [];
    // `latest` may have been one of the dropped articles.
    const latest = survivors.reduce(
      (best, a) => (Date.parse(a.savedAt) > Date.parse(best) ? a.savedAt : best),
      survivors[0].savedAt,
    );
    return [{ ...source, count, latest }];
  });

  const result: GetArchiveResult = {
    windowDays: sinceDays,
    totalUsable: Math.max(0, listed.totalUsable - dropped.length),
    sources,
    // Free-text dates are dropped here so the model never has to parse one.
    articles: kept
      .slice(0, limit)
      .map((a) => ({ ...a, publishedAt: isoDateOrUndefined(a.publishedAt) })),
  };
  if (dropped.length) emit.log(`blocked: ${dropped.length} archived article(s)`);
  emit.log(`archive: ${result.articles.length} of ${result.totalUsable} articles`);
  return result;
}

async function runGetArchiveArticles(
  event: CustomToolUse,
  ctx: {
    client: Anthropic;
    archive: ArchiveBridge | undefined;
    sessionId: string;
    rememberUpload: (id: string) => Promise<void>;
    mounted: Map<string, ArchiveRef>;
    emit: Emit;
    blockedSites: string[];
  },
): Promise<GetArchiveArticlesResult> {
  if (!ctx.archive) throw new Error(`${ARCHIVE_UNAVAILABLE}: none is configured for this build.`);
  const input = event.input as { ids?: unknown };
  const requested = (Array.isArray(input.ids) ? input.ids : [])
    .filter((id): id is string => typeof id === "string" && id.trim() !== "")
    .map((id) => id.trim());
  const distinct = [...new Set(requested)];
  if (distinct.length === 0) throw new Error("getArchiveArticles needs at least one article id.");

  // The id becomes a path segment on the archive host, so only plain ids get that far.
  const unique = distinct.filter((id) => ARCHIVE_ID.test(id));
  const max = DEFAULTS.maxArchiveArticles;
  const ids = unique.slice(0, max);
  const failed: GetArchiveArticlesResult["failed"] = [
    ...distinct.filter((id) => !ARCHIVE_ID.test(id)).map((id) => ({ id, reason: "invalid article id" })),
    ...unique.slice(max).map((id) => ({ id, reason: `over the ${max}-article limit` })),
  ];
  ctx.emit.phase("scraping", `${ids.length} archived articles`);

  const blockedReason = "blocked by the user's settings";
  const refs: ArchiveRef[] = [];
  let blockedCount = 0;
  const candidates: string[] = [];
  for (const id of ids) {
    const have = ctx.mounted.get(id);
    if (!have) candidates.push(id);
    else if (isAllowedUrl(have.originalUrl, ctx.blockedSites)) refs.push(have);
    else {
      failed.push({ id, reason: blockedReason });
      blockedCount++;
    }
  }

  // A whole-build ceiling on what reaches the API, whatever the model asks for.
  const room = Math.max(0, DEFAULTS.maxArchiveMountsPerBuild - ctx.mounted.size);
  const toFetch = candidates.slice(0, room);
  for (const id of candidates.slice(room)) {
    failed.push({ id, reason: "over the per-build archive limit" });
  }

  const fetched: ArchiveArticle[] = [];
  if (toFetch.length) {
    let response: Awaited<ReturnType<ArchiveBridge["getArticles"]>>;
    try {
      response = await ctx.archive.getArticles({ ids: toFetch });
    } catch (err) {
      throw new Error(`${ARCHIVE_UNAVAILABLE}: ${err instanceof Error ? err.message : String(err)}`);
    }
    const asked = new Set(toFetch);
    const answered = new Set<string>();
    for (const article of response.articles) {
      if (!asked.has(article.id) || answered.has(article.id)) continue;
      answered.add(article.id);
      // Checked before upload: a blocked article's text never leaves this process.
      if (isAllowedUrl(article.originalUrl, ctx.blockedSites)) {
        fetched.push(article);
      } else {
        failed.push({ id: article.id, reason: blockedReason });
        blockedCount++;
      }
    }
    for (const miss of response.failed) {
      if (!asked.has(miss.id) || answered.has(miss.id)) continue;
      answered.add(miss.id);
      failed.push(miss);
    }
    // Every requested id gets an answer, even one the archive said nothing about.
    for (const id of toFetch) {
      if (!answered.has(id)) failed.push({ id, reason: "not returned by the archive" });
    }
  }
  if (blockedCount) ctx.emit.log(`blocked: ${blockedCount} archived article(s)`);

  for (const article of fetched) {
    try {
      const safeId = article.id.replace(/[^A-Za-z0-9_-]+/g, "_") || "article";
      const { text, truncated } = truncateWords(article.text, DEFAULTS.archiveWordLimit);
      const file = new File([archiveFileText(article, text, truncated)], `${safeId}.txt`, {
        type: "text/plain",
      });
      const upload = await ctx.client.beta.files.upload({ file });
      await ctx.rememberUpload(upload.id);

      // The upload id keeps each mount path unique, so a re-answered call after a
      // reattach can't collide with a file it mounted before the host was killed.
      const resource = await ctx.client.beta.sessions.resources.add(ctx.sessionId, {
        type: "file",
        file_id: upload.id,
        mount_path: `${UPLOAD_ROOT}/archive/${safeId}-${upload.id.slice(-8)}.txt`,
      });

      const ref: ArchiveRef = {
        id: article.id,
        title: article.title,
        site: article.site,
        permalink: article.permalink,
        originalUrl: article.originalUrl,
        // As with pages: what the API resolved, not what we asked for.
        mountPath: resource.mount_path,
        bytes: file.size,
        wordCount: article.wordCount,
        truncated,
      };
      ctx.mounted.set(article.id, ref);
      refs.push(ref);
      ctx.emit.log(`mounted archive ${article.id} -> ${resource.mount_path} (${file.size}b)`);
    } catch (err) {
      failed.push({ id: article.id, reason: `mount failed: ${String(err)}` });
    }
  }

  // Failures are reported, never thrown: one bad mount must not hide the ones that worked.
  return { articles: refs, failed };
}

// ---------------------------------------------------------------------------
// deliverable retrieval
// ---------------------------------------------------------------------------

const CODE_FENCE = /```(?:tsx|jsx|ts|js|typescript|javascript)?\s*\n([\s\S]*?)```/;

/** Strip a ```tsx fence, if the model wrapped the file contents in one. */
function stripFence(text: string): string {
  const fenced = text.match(CODE_FENCE);
  return (fenced ? fenced[1] : text).trim();
}

async function collectDeliverable(
  client: Anthropic,
  sessionId: string,
  finalMessage: string,
  emit: Emit,
): Promise<{ code: string; source: HomepageBuildResult["source"] }> {
  // There is a short indexing lag between status_idle and outputs appearing.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      for await (const file of client.beta.files.list({
        scope_id: sessionId,
        betas: [MANAGED_AGENTS_BETA],
      })) {
        if (!/\.(tsx|jsx|ts|js)$/.test(file.filename)) continue;
        const response = await client.beta.files.download(file.id);
        const text = await response.text();
        if (text.trim()) {
          emit.log(`deliverable from session output: ${file.filename} (${text.length}b)`);
          return { code: stripFence(text), source: "session-output" };
        }
      }
    } catch (err) {
      emit.log(`files.list attempt ${attempt + 1} failed: ${String(err)}`);
    }
    await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
  }

  // Fallback: the model sometimes answers with the component inline instead of
  // (or as well as) writing it. Better than failing the run outright.
  const fenced = finalMessage.match(CODE_FENCE);
  if (fenced && fenced[1].includes("PersonalizedHomepage")) {
    emit.log("deliverable recovered from message fence");
    return { code: fenced[1].trim(), source: "message-fence" };
  }

  throw new Error(
    `Agent produced no homepage. Expected a file at ${OUTPUT_PATH}. ` +
      `Final message: ${finalMessage.slice(0, 400)}`,
  );
}

/**
 * A running session can't be deleted ("cannot delete while running"). After a
 * normal finish that's only the brief lag between the stream's idle and the
 * queryable status. After a cancel or error the agent is still mid-turn, so it
 * gets interrupted and has to reach a safe boundary before it goes idle.
 */
const SETTLE_POLLS_BEFORE_INTERRUPT = 10;
const INTERRUPT_DEADLINE_MS = 60_000;

async function deleteSessionWhenSettled(client: Anthropic, sessionId: string): Promise<void> {
  const deadline = Date.now() + INTERRUPT_DEADLINE_MS;
  let interrupted = false;
  for (let attempt = 0; Date.now() < deadline; attempt++) {
    const session = await client.beta.sessions.retrieve(sessionId);
    if (session.status !== "running") break;
    if (!interrupted && attempt >= SETTLE_POLLS_BEFORE_INTERRUPT) {
      await client.beta.sessions.events.send(sessionId, { events: [{ type: "user.interrupt" }] });
      interrupted = true;
    }
    await new Promise((r) => setTimeout(r, interrupted ? 1000 : 200));
  }
  await client.beta.sessions.delete(sessionId);
}
