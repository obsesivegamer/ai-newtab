import Anthropic from "@anthropic-ai/sdk";
import { archiveHostOf, normalizeArchiveUrl, runHomepageBuild, type RunPhase } from "@homepage/agent-core";
import { rebuildIntervalMs, shouldAutoRebuild } from "./auto-rebuild";
import { createFailoverArchiveBridge } from "./archive-reading";
import { createFeedBridge } from "./feeds";
import { isSourceBlocked, loadSources } from "./sources";
import { browserBridge } from "./browser-bridge";
import {
  INITIAL_BUILD_STATE,
  LOG_RETENTION,
  stepForPhase,
  type BuildMsg,
  type BuildState,
  type PageMsg,
} from "./protocol";
import { publishBuiltHomepage } from "./phone-sync";
import { fallbackBaseOf, noteMissingReaderPassword, READER_PASSWORD_MISSING } from "./archive-auth";
import {
  READER_AUTH_MESSAGE,
  REBUILD_POLL_MIN_MS,
  canPollRebuildRequest,
  fetchRebuildRequest,
  forgetRebuildRequestId,
  normalizeHandledRebuildIds,
  passwordFingerprint,
  persistedReaderAuthNotice,
  readerAuthNotice,
  readerAuthStillRejected,
  rebuildTickAction,
  rememberRebuildRequestId,
} from "./rebuild-request";
import { KEYS, extensionStore, loadHomepage, loadSettings, saveHomepage } from "./storage";

type Port = Parameters<Parameters<typeof browser.runtime.onConnect.addListener>[0]>[0];

/**
 * While a turn is active, ping a cheap chrome API on this interval to reset the
 * ~30s MV3 idle-unload timer. The ~1 min alarm heartbeat is the slower safety
 * net that reattaches after an unexpected kill.
 */
const KEEPALIVE_INTERVAL_MS = 20_000;
/** One retry, after a short pause, when the Anthropic SDK reports a connection error. */
const CONNECTION_RETRY_MS = 500;

/** Storage snapshots are throttled so narration deltas don't flood chrome.storage. */
const SNAPSHOT_THROTTLE_MS = 2_000;
/** A late-joining tab doesn't need the whole narration, just enough to look alive. */
const NARRATION_STORAGE_CAP = 2_000;

/**
 * Owns the single build. Runs `runHomepageBuild` in the worker, holds live state,
 * enforces a single-flight lock, broadcasts progress to every connected tab,
 * mirrors a throttled snapshot to storage, and reattaches to an interrupted run
 * on wake.
 *
 * There is one instance per service worker — i.e. one per browser profile — so
 * single-flight is per-profile, which is the right grain.
 */
export class BuildManager {
  private state: BuildState = { ...INITIAL_BUILD_STATE };
  private readonly ports = new Set<Port>();
  private controller: AbortController | null = null;
  /**
   * Single-flight claim. Set synchronously at the start of a tick, before any
   * await, and held until a build starts or the tick decides not to build.
   */
  private running = false;
  /** True once `startBuild` has entered. A phone id seen meanwhile is remembered, not built again. */
  private building = false;
  private keepalive: ReturnType<typeof setInterval> | null = null;
  private lastSnapshotAt = 0;
  private snapshotTimer: ReturnType<typeof setTimeout> | null = null;
  /** Epoch ms of the last reader rebuild-request poll. The alarm is about a minute. */
  private lastRebuildPollAt = 0;
  private authRestore: Promise<void> = Promise.resolve();
  /** Request ids this build stored. A failure puts them back; a success keeps them. */
  private claimedRequestIds: string[] = [];

  constructor() {
    void this.restoreReaderAuthNotice();
  }

  // ---- port lifecycle ------------------------------------------------------

  attach(port: Port) {
    this.ports.add(port);
    port.onMessage.addListener((raw: unknown) => this.onPageMessage(port, raw as PageMsg));
    port.onDisconnect.addListener(() => this.ports.delete(port));
  }

  private onPageMessage(port: Port, msg: PageMsg) {
    switch (msg.kind) {
      case "subscribe":
        // The snapshot has to include a 401 banner restored from storage. Sending
        // the empty in-memory state first would wipe the banner on every reconnect.
        void this.restoreReaderAuthNotice().then(() => {
          this.send(port, { kind: "snapshot", state: this.state });
        });
        break;
      case "startBuild":
        void this.startBuild({ resume: msg.resume });
        break;
      case "cancel":
        this.cancel();
        break;
    }
  }

  private send(port: Port, msg: BuildMsg) {
    try {
      port.postMessage(msg);
    } catch {
      // Port went away between the has-check and the post; drop it.
      this.ports.delete(port);
    }
  }

  private broadcast(msg: BuildMsg) {
    for (const port of [...this.ports]) this.send(port, msg);
  }

  // ---- heartbeat -----------------------------------------------------------

  /**
   * Called on worker wake and on every alarm tick. If a session was left
   * mid-flight, reattach and continue (lossless — the orchestrator replays the
   * event log and re-answers orphaned tool calls). Otherwise, consider the daily
   * rebuild. The single-flight lock is the arbiter that keeps these from racing.
   */
  async tick() {
    if (this.running) {
      // A run is live but the worker may have just woken; make sure the
      // self-keepalive is ticking so the active turn stays warm. Keep noting
      // phone requests so the id is claimed and the next tick does not start
      // a second build.
      if (this.building) {
        this.startKeepalive();
        if (this.notePhoneRequest()) this.watchPhoneRequest();
      }
      return;
    }

    const pollDue = this.notePhoneRequest();
    // Claim the build before any await. A second tick in this minute, and the
    // scheduled check racing the reader poll, then share one build.
    this.running = true;
    void this.restoreReaderAuthNotice();

    try {
      const sessionId = await extensionStore.get<string>(KEYS.activeSessionId);
      if (sessionId) {
        void this.startBuild({ resume: true, claimed: true });
        if (pollDue) this.watchPhoneRequest();
        return;
      }

      // The schedule runs to completion before the reader is asked. A phone
      // request due on the same tick is remembered onto that build.
      const scheduled = await this.maybeAutoRebuild();
      if (scheduled) {
        void this.startBuild({ resume: false, claimed: true });
        if (pollDue) this.watchPhoneRequest();
        return;
      }

      if (!pollDue) {
        if (!this.building) this.running = false;
        return;
      }

      const startPhone = await this.maybeRequestedRebuild();
      if (startPhone) {
        void this.startBuild({ resume: false, claimed: true });
        return;
      }
      if (!this.building) this.running = false;
    } catch (err) {
      if (!this.building) this.running = false;
      console.warn(
        "[BuildManager] tick failed",
        err instanceof Error ? err.message : "request failed",
      );
    }
  }

  /**
   * Reserve the reader poll if it is due. The reservation is synchronous, before
   * any await, so two ticks cannot both ask. Returns whether this tick should poll.
   */
  private notePhoneRequest(): boolean {
    const now = Date.now();
    if (now - this.lastRebuildPollAt < REBUILD_POLL_MIN_MS) return false;
    this.lastRebuildPollAt = now;
    return true;
  }

  /** Put a stored 401 banner back. Polling stays paused, so nothing else would show it again. */
  private restoreReaderAuthNotice(): Promise<void> {
    const run = this.authRestore
      .then(async () => {
        const settings = await loadSettings();
        const reader = fallbackBaseOf(settings.fallbackArchiveUrl);
        if (reader && !settings.readerPassword.trim()) {
          noteMissingReaderPassword();
          if (this.state.notice !== READER_PASSWORD_MISSING) this.onNotice(READER_PASSWORD_MISSING);
          return;
        }
        if (this.state.notice === READER_PASSWORD_MISSING) this.onNotice(null);
        const rejected = await extensionStore.get<string>(KEYS.readerAuthRejected);
        const fingerprint = settings.readerPassword ? await passwordFingerprint(settings.readerPassword) : "";
        const next = persistedReaderAuthNotice(rejected, fingerprint, this.state.notice);
        if (next !== this.state.notice) this.onNotice(next);
      })
      .catch((err) => {
        console.warn(
          "[BuildManager] couldn't restore the reader notice",
          err instanceof Error ? err.message : "request failed",
        );
      });
    this.authRestore = run;
    return run;
  }

  private watchPhoneRequest() {
    void this.maybeRequestedRebuild().catch((err) => {
      console.warn(
        "[BuildManager] rebuild request check failed",
        err instanceof Error ? err.message : "request failed",
      );
    });
  }

  /**
   * A phone refresh can ask the reader for a rebuild. The minute gate was already
   * claimed by `tick`. One unseen id whose `fulfilled_at` is null starts one
   * build, unless a build is already entering, in which case the id is only
   * remembered. A wrong password is stored once; the banner stays until the
   * password changes and a later GET succeeds.
   */
  private async maybeRequestedRebuild(): Promise<boolean> {
    const settings = await loadSettings();
    const reader = fallbackBaseOf(settings.fallbackArchiveUrl);
    const configured = Boolean(reader && settings.readerPassword);
    const [handledRaw, rejected] = await Promise.all([
      extensionStore.get<unknown>(KEYS.handledRebuildRequestIds),
      extensionStore.get<string>(KEYS.readerAuthRejected),
    ]);
    const fingerprint = settings.readerPassword ? await passwordFingerprint(settings.readerPassword) : "";
    const authRejected = readerAuthStillRejected(rejected, fingerprint);
    if (
      !reader ||
      !canPollRebuildRequest({
        readerConfigured: configured,
        hasApiKey: Boolean(settings.apiKey),
        autoRebuild: settings.autoRebuild,
        authRejected,
      })
    ) {
      return false;
    }
    const request = await fetchRebuildRequest(reader, settings.readerPassword, settings.archiveUrl);
    if (request.status === "unauthorized") {
      const line = readerAuthNotice(authRejected);
      if (line) {
        await extensionStore.set(KEYS.readerAuthRejected, fingerprint);
        console.warn(`[BuildManager] ${line}`);
        this.onLog(line);
        this.onNotice(line);
      }
      return false;
    }
    if (rejected && (request.status === "ready" || request.status === "none")) {
      await extensionStore.remove(KEYS.readerAuthRejected);
      if (this.state.notice === READER_AUTH_MESSAGE) this.onNotice(null);
    }
    const handled = normalizeHandledRebuildIds(handledRaw);
    const action = rebuildTickAction({ running: this.building, request, handledIds: handled });
    if (action === "skip" || request.status !== "ready") return false;
    if (!this.claimedRequestIds.includes(request.request.id)) this.claimedRequestIds.push(request.request.id);
    await extensionStore.set(
      KEYS.handledRebuildRequestIds,
      rememberRebuildRequestId(handled, request.request.id),
    );
    return action === "start";
  }

  /** A failed build did not fulfill these requests, so the next tick may try again. */
  private async forgetClaimedRequests(): Promise<void> {
    const ids = this.claimedRequestIds;
    if (ids.length === 0) return;
    const handled = normalizeHandledRebuildIds(await extensionStore.get<unknown>(KEYS.handledRebuildRequestIds));
    const next = ids.reduce((list, id) => forgetRebuildRequestId(list, id), handled);
    await extensionStore.set(KEYS.handledRebuildRequestIds, next);
  }

  /**
   * Whether this tick should start the scheduled rebuild. The tick has already
   * claimed `this.running`; that is not a build in progress, so `isRunning` stays
   * false. Returns after the attempt is stamped, and the caller starts the build.
   */
  private async maybeAutoRebuild(): Promise<boolean> {
    const [settings, homepage, lastAttempt] = await Promise.all([
      loadSettings(),
      loadHomepage(),
      extensionStore.get<string>(KEYS.lastAutoBuildAttempt),
    ]);
    const now = new Date();

    if (
      !shouldAutoRebuild({
        enabled: settings.autoRebuild,
        hasApiKey: Boolean(settings.apiKey),
        isRunning: false,
        lastBuildTimestamp: homepage?.timestamp,
        lastAutoAttemptTimestamp: lastAttempt,
        intervalMs: rebuildIntervalMs(settings.rebuildIntervalHours),
        now,
      })
    ) {
      return false;
    }

    // Stamp the attempt before starting so a second wake (or a cancel/failure)
    // doesn't re-trigger it within the interval. The claim is already held.
    await extensionStore.set(KEYS.lastAutoBuildAttempt, now.toISOString());
    return true;
  }

  // ---- the build -----------------------------------------------------------

  async startBuild(opts: { resume?: boolean; claimed?: boolean } = {}) {
    // Block on a build that has entered. The tick's provisional claim, held while
    // it asks the reader, must not swallow a Build click.
    if (this.building) {
      if (!opts.claimed) console.log("[BuildManager] startBuild ignored — a build is already running");
      return;
    }
    // Claim the slot before the first await: the startup tick, the onStartup
    // listener and an alarm can all call this in the same turn. `claimed` means
    // the tick already set `running` and this call is the one build.
    this.running = true;
    this.building = true;

    let settings: Awaited<ReturnType<typeof loadSettings>>;
    try {
      settings = await loadSettings();
    } catch (err) {
      await this.releaseClaimedRequests();
      this.running = false;
      this.building = false;
      throw err;
    }
    const { apiKey, systemPrompt, model, archiveUrl } = settings;
    if (!apiKey) {
      await this.releaseClaimedRequests();
      this.running = false;
      this.building = false;
      // Manual builds are gated behind the key-setup screen and auto-builds
      // require a key, so this only happens if the key was removed.
      console.warn("[BuildManager] startBuild aborted — no API key in storage");
      const message = "No Anthropic API key found. Add your key and try again.";
      this.state = { ...INITIAL_BUILD_STATE, phase: "error", error: message };
      this.broadcast({ kind: "error", message });
      return;
    }

    const archiveBase = normalizeArchiveUrl(archiveUrl);
    if (archiveUrl.trim() && !archiveBase) {
      console.warn("[BuildManager] archive URL is not a valid http(s) address; building without the archive");
    }

    // Read like archiveUrl: once, at build start. A catalog that can't be read just means no feeds.
    // A source on the blocked list is never fetched at all, so its headlines can't reach the model.
    let feeds: ReturnType<typeof createFeedBridge> | undefined;
    try {
      const sources = (await loadSources()).filter((s) => !isSourceBlocked(s, settings.blockedSites));
      if (sources.some((s) => s.enabled)) feeds = createFeedBridge(sources);
    } catch (err) {
      console.warn("[BuildManager] couldn't read the sources list; building without live feeds", err);
    }

    const controller = new AbortController();
    this.controller = controller;
    this.state = { ...INITIAL_BUILD_STATE, running: true, phase: "setup", notice: this.state.notice };
    this.broadcast({ kind: "snapshot", state: this.state });
    this.startKeepalive();
    console.log("[BuildManager] build started", { resume: Boolean(opts.resume) });

    try {
      // The key is the user's own, read from local storage — there is no server
      // to hide it behind. See ARCHITECTURE.md → Privacy.
      const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });

      const resumeSessionId = opts.resume
        ? await extensionStore.get<string>(KEYS.activeSessionId)
        : undefined;

      const attempt = () =>
        runHomepageBuild({
          client,
          bridge: browserBridge,
          // Empty (or unusable) URL turns the archive off; the build then runs on history alone.
          archive: archiveBase
            ? createFailoverArchiveBridge(archiveBase, {
                macBase: archiveBase,
                fallbackBase: settings.fallbackArchiveUrl,
                password: settings.readerPassword,
              })
            : undefined,
          feeds,
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          store: extensionStore,
          userSystemPrompt: systemPrompt,
          // The archive's own host is never a page the agent may scrape: its index
          // lists every saved article, including ones from blocked sites. Both the
          // address this build started with and the one in Settings now are blocked,
          // so changing the setting mid-build can't expose the one in use.
          blockedSites: async () => {
            const { blockedSites, archiveUrl: current, fallbackArchiveUrl } = await loadSettings();
            const hosts = [archiveBase, current, fallbackArchiveUrl].flatMap((url) =>
              url ? (archiveHostOf(url) ?? []) : [],
            );
            return [...blockedSites, ...hosts];
          },
          model,
          resumeSessionId,
          signal: controller.signal,
          callbacks: {
            onPhase: (phase, detail) => this.onPhase(phase, detail),
            onText: (chunk) => this.onText(chunk),
            onLog: (line) => this.onLog(line),
          },
        });
      let result: Awaited<ReturnType<typeof runHomepageBuild>>;
      try {
        result = await attempt();
      } catch (error) {
        if (!isConnectionError(error) || controller.signal.aborted) throw error;
        console.warn("[BuildManager] connection error; retrying once", connectionCause(error) || "no cause");
        await new Promise((resolve) => setTimeout(resolve, CONNECTION_RETRY_MS));
        if (controller.signal.aborted) throw error;
        result = await attempt();
      }

      // Persist the raw TSX; the page transpiles it for preview.
      const homepage = await saveHomepage(result.code);
      // Hand it to the Mac archive and, separately, to the offline reader. Both are
      // best-effort. The reader push cannot fail the Mac one, and its password never
      // goes to the Mac. Each refuses a public address (`publishBuiltHomepage`).
      void publishBuiltHomepage(
        archiveBase,
        settings.fallbackArchiveUrl,
        settings.readerPassword,
        homepage,
      );

      this.state = { ...this.state, running: false, phase: "done" };
      this.broadcast({ kind: "done", code: result.code });
      await this.mirror(true);
      console.log("[BuildManager] build done", { bytes: result.code.length, source: result.source });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const aborted = this.controller?.signal.aborted === true || (error instanceof Error && error.name === "AbortError");
      if (!aborted) await this.forgetClaimedRequests();
      this.state = { ...this.state, running: false, phase: "error", error: message };
      this.broadcast({ kind: "error", message });
      await this.mirror(true);
      this.notifyFailure(message);
      const cause = connectionCause(error);
      console.error("[BuildManager] build failed", cause ? `${message} (${cause})` : message);
    } finally {
      this.claimedRequestIds = [];
      this.running = false;
      this.building = false;
      this.controller = null;
      this.stopKeepalive();
    }
  }

  /** Forget a request this build stored, then drop the in-memory mark. */
  private async releaseClaimedRequests(): Promise<void> {
    try {
      await this.forgetClaimedRequests();
    } catch (err) {
      console.warn(
        "[BuildManager] couldn't clear the rebuild request",
        err instanceof Error ? err.message : "request failed",
      );
    }
    this.claimedRequestIds = [];
  }

  cancel() {
    this.controller?.abort();
  }

  // ---- callback fan-out ----------------------------------------------------

  private onPhase(phase: RunPhase, detail?: string) {
    const mapped = stepForPhase(phase);
    const stepIndex =
      mapped === undefined ? this.state.stepIndex : Math.max(this.state.stepIndex, mapped);
    this.state = { ...this.state, phase, stepIndex, detail: detail ?? "" };
    this.broadcast({ kind: "phase", phase, stepIndex, detail: detail ?? "" });
    void this.mirror(false);
  }

  private onText(chunk: string) {
    this.state = { ...this.state, narration: this.state.narration + chunk };
    this.broadcast({ kind: "text", chunk });
    void this.mirror(false);
  }

  private onLog(line: string) {
    this.state = { ...this.state, logs: [...this.state.logs.slice(-LOG_RETENTION), line] };
    this.broadcast({ kind: "log", line });
    void this.mirror(false);
  }

  private onNotice(message: string | null) {
    this.state = { ...this.state, notice: message };
    this.broadcast({ kind: "notice", message });
    void this.mirror(true);
  }

  // ---- storage mirror ------------------------------------------------------

  /**
   * Mirror a lightweight snapshot to storage so a tab that opens while the worker
   * is asleep paints last-known state instantly; the heartbeat then revives the
   * live run. Deltas go over the port; storage only gets a throttled snapshot.
   */
  private async mirror(force: boolean) {
    const now = Date.now();
    if (!force && now - this.lastSnapshotAt < SNAPSHOT_THROTTLE_MS) {
      this.snapshotTimer ??= setTimeout(() => {
        this.snapshotTimer = null;
        void this.mirror(true);
      }, SNAPSHOT_THROTTLE_MS);
      return;
    }

    this.lastSnapshotAt = now;
    if (this.snapshotTimer) {
      clearTimeout(this.snapshotTimer);
      this.snapshotTimer = null;
    }

    const trimmed: BuildState = {
      ...this.state,
      narration: this.state.narration.slice(-NARRATION_STORAGE_CAP),
      logs: this.state.logs.slice(-LOG_RETENTION),
    };
    await extensionStore.set(KEYS.buildSnapshot, trimmed);
  }

  // ---- worker keepalive ----------------------------------------------------

  private startKeepalive() {
    this.keepalive ??= setInterval(() => {
      // A cheap chrome API call resets the ~30s idle-unload timer while a turn is
      // in flight (the in-flight session fetch does most of the work; this covers
      // the gaps between requests).
      void browser.runtime.getPlatformInfo();
    }, KEEPALIVE_INTERVAL_MS);
  }

  private stopKeepalive() {
    if (this.keepalive) clearInterval(this.keepalive);
    this.keepalive = null;
  }

  // ---- failure surfacing ---------------------------------------------------

  private notifyFailure(message: string) {
    // Only ping when nobody is watching — an open tab already shows the error
    // inline. A headless daily build that fails otherwise vanishes silently.
    if (this.ports.size > 0) return;
    try {
      browser.notifications.create({
        type: "basic",
        iconUrl: browser.runtime.getURL("/icon/128.png"),
        title: "Homepage build failed",
        message: message.slice(0, 200),
      });
    } catch {
      // notifications permission missing or API unavailable — nothing else to do.
    }
  }
}

function isConnectionError(error: unknown): boolean {
  return error instanceof Error && error.message === "Connection error.";
}

/** A short cause string. The error object itself can carry request headers, so it is not logged. */
function connectionCause(error: unknown): string {
  if (!(error instanceof Error)) return "";
  const cause = error.cause;
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "string") return cause;
  return "";
}
