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
import { fallbackBaseOf } from "./archive-auth";
import {
  READER_AUTH_MESSAGE,
  fetchRebuildRequest,
  normalizeHandledRebuildIds,
  passwordFingerprint,
  readerAuthNotice,
  readerAuthStillRejected,
  rebuildTickAction,
  rememberRebuildRequestId,
  shouldPollRebuildRequest,
} from "./rebuild-request";
import { KEYS, extensionStore, loadHomepage, loadSettings, saveHomepage } from "./storage";

type Port = Parameters<Parameters<typeof browser.runtime.onConnect.addListener>[0]>[0];

/**
 * While a turn is active, ping a cheap chrome API on this interval to reset the
 * ~30s MV3 idle-unload timer. The ~1 min alarm heartbeat is the slower safety
 * net that reattaches after an unexpected kill.
 */
const KEEPALIVE_INTERVAL_MS = 20_000;

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
  private running = false;
  private keepalive: ReturnType<typeof setInterval> | null = null;
  private lastSnapshotAt = 0;
  private snapshotTimer: ReturnType<typeof setTimeout> | null = null;
  /** Epoch ms of the last reader rebuild-request poll. The alarm is already ~1 min. */
  private lastRebuildPollAt = 0;

  // ---- port lifecycle ------------------------------------------------------

  attach(port: Port) {
    this.ports.add(port);
    port.onMessage.addListener((raw: unknown) => this.onPageMessage(port, raw as PageMsg));
    port.onDisconnect.addListener(() => this.ports.delete(port));
  }

  private onPageMessage(port: Port, msg: PageMsg) {
    switch (msg.kind) {
      case "subscribe":
        this.send(port, { kind: "snapshot", state: this.state });
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
      // self-keepalive is ticking so the active turn stays warm.
      this.startKeepalive();
      return;
    }

    const sessionId = await extensionStore.get<string>(KEYS.activeSessionId);
    if (sessionId) {
      void this.startBuild({ resume: true });
      return;
    }

    // The reader check has its own short timeout and must not hold up the schedule.
    void this.maybeRequestedRebuild().catch((err) => {
      console.warn(
        "[BuildManager] rebuild request check failed",
        err instanceof Error ? err.message : "request failed",
      );
    });
    await this.maybeAutoRebuild();
  }

  /**
   * A phone refresh can ask the reader for a rebuild. Ask at most once a minute,
   * and only with a reader address, a password, an API key, and auto-rebuild on.
   * One unseen id whose `fulfilled_at` is null starts one build. A wrong password
   * is reported once, then left alone until the password changes.
   */
  private async maybeRequestedRebuild(): Promise<void> {
    const now = Date.now();
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
      !shouldPollRebuildRequest({
        running: this.running,
        now,
        lastPollAt: this.lastRebuildPollAt,
        readerConfigured: configured,
        hasApiKey: Boolean(settings.apiKey),
        autoRebuild: settings.autoRebuild,
        authRejected,
      })
    ) {
      return;
    }
    this.lastRebuildPollAt = now;
    const request = await fetchRebuildRequest(reader, settings.readerPassword, settings.archiveUrl);
    if (request.status === "unauthorized") {
      const line = readerAuthNotice(authRejected);
      if (line) {
        await extensionStore.set(KEYS.readerAuthRejected, fingerprint);
        console.warn(`[BuildManager] ${line}`);
        this.onLog(line);
        this.onNotice(line);
      }
      return;
    }
    if (rejected && (request.status === "ready" || request.status === "none")) {
      await extensionStore.remove(KEYS.readerAuthRejected);
      if (this.state.notice === READER_AUTH_MESSAGE) this.onNotice(null);
    }
    const handled = normalizeHandledRebuildIds(handledRaw);
    const action = rebuildTickAction({ running: this.running, request, handledIds: handled });
    if (action === "skip" || request.status !== "ready") return;
    await extensionStore.set(
      KEYS.handledRebuildRequestIds,
      rememberRebuildRequestId(handled, request.request.id),
    );
    if (action === "start") void this.startBuild({ resume: false });
  }

  /** Whether opening the day's first tab should already show a fresh homepage. */
  private async maybeAutoRebuild() {
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
        isRunning: this.running,
        lastBuildTimestamp: homepage?.timestamp,
        lastAutoAttemptTimestamp: lastAttempt,
        intervalMs: rebuildIntervalMs(settings.rebuildIntervalHours),
        now,
      })
    ) {
      return;
    }

    // Stamp the attempt before starting so a second wake (or a cancel/failure)
    // doesn't re-trigger it within the interval.
    await extensionStore.set(KEYS.lastAutoBuildAttempt, now.toISOString());
    void this.startBuild({ resume: false });
  }

  // ---- the build -----------------------------------------------------------

  async startBuild(opts: { resume?: boolean } = {}) {
    if (this.running) {
      console.log("[BuildManager] startBuild ignored — a build is already running");
      return; // single-flight: a second start just attaches.
    }
    // Claim the slot before the first await: the startup tick, the onStartup
    // listener and an alarm can all call this in the same turn.
    this.running = true;

    let settings: Awaited<ReturnType<typeof loadSettings>>;
    try {
      settings = await loadSettings();
    } catch (err) {
      this.running = false;
      throw err;
    }
    const { apiKey, systemPrompt, model, archiveUrl } = settings;
    if (!apiKey) {
      this.running = false;
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

    this.controller = new AbortController();
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

      const result = await runHomepageBuild({
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
        signal: this.controller.signal,
        callbacks: {
          onPhase: (phase, detail) => this.onPhase(phase, detail),
          onText: (chunk) => this.onText(chunk),
          onLog: (line) => this.onLog(line),
        },
      });

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
      this.state = { ...this.state, running: false, phase: "error", error: message };
      this.broadcast({ kind: "error", message });
      await this.mirror(true);
      this.notifyFailure(message);
      console.error("[BuildManager] build failed", error);
    } finally {
      this.running = false;
      this.controller = null;
      this.stopKeepalive();
    }
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
