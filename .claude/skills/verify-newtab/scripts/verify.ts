/**
 * Visual + DOM verification of the built new-tab extension against a real
 * (read-only) Amber instance.
 *
 *   npx -y bun .claude/skills/verify-newtab/scripts/verify.ts \
 *     [--out <dir>] [--amber-dir <path>] [--python <path>] [--data-from <dir>] \
 *     [--port <n>] [--build] [--chrome-port <n>] [--no-save] [--probe-paywall]
 *
 * What it does:
 *   1. checks the build exists (or builds it with --build) and warns if it is stale,
 *   2. COPIES Amber's data dir to a temp dir and starts Amber from --amber-dir on
 *      --port (default 8090) against the copy, so the Latest -> Reader save flow
 *      (POST /api/save, a real capture) never writes to the real data,
 *   3. loads the unpacked extension into headless Chrome over CDP's Extensions
 *      domain (Chrome 136+ ignores --load-extension), points archiveUrl at Amber,
 *   4. drives the real UI (mouse clicks, key events) and screenshots dark and light,
 *   5. prints cheap DOM assertions and kills everything it started.
 *
 * Screenshots go to --out (default: a fresh temp dir), never into the repo.
 * It never touches port 8080 or Amber's launchd service.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Arguments and paths
// ---------------------------------------------------------------------------

const REPO = resolve(import.meta.dir, "../../../..");
const EXT = join(REPO, "apps/extension/.output/chrome-mv3");
const DOCS = join(homedir(), "Documents");
const DEFAULT_AMBER = join(DOCS, "amber-archive");
const CHROME =
  process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

if (flag("help") || flag("h")) {
  console.log(
    "usage: verify.ts [--out <dir>] [--amber-dir <path>] [--python <path>] [--data-from <dir>] [--port <n>] [--build] [--chrome-port <n>] [--no-save] [--probe-paywall]",
  );
  process.exit(0);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const OUT = resolve(arg("out") ?? mkdtempSync(join(tmpdir(), "verify-newtab-")));
mkdirSync(OUT, { recursive: true });
const AMBER_PORT = Number(arg("port") ?? 8090);
if (!Number.isInteger(AMBER_PORT) || AMBER_PORT < 1024 || AMBER_PORT > 65535 || AMBER_PORT === 8080) {
  console.error("--port must be an unprivileged port other than 8080 (that is the live Amber).");
  process.exit(2);
}
const AMBER = `http://127.0.0.1:${AMBER_PORT}`;

// ---------------------------------------------------------------------------
// Process bookkeeping: everything we spawn dies with us
// ---------------------------------------------------------------------------

let amberProc: ChildProcess | null = null;
let chromeProc: ChildProcess | null = null;
let fixtureServer: { stop(force?: boolean): void } | null = null;
let profileDir = "";
let dataCopyDir = "";

function killEverything() {
  try {
    fixtureServer?.stop(true);
  } catch {
    /* already gone */
  }
  for (const p of [amberProc, chromeProc]) {
    try {
      if (p?.pid && p.exitCode === null) p.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
  if (chromeProc?.pid) {
    try {
      process.kill(-chromeProc.pid, "SIGKILL"); // Chrome's helper processes share its group
    } catch {
      /* already gone */
    }
  }
  if (profileDir) {
    // Anything still carrying our unique temp profile path in its command line is ours.
    spawnSync("pkill", ["-9", "-f", profileDir], { stdio: "ignore" });
    rmSync(profileDir, { recursive: true, force: true });
  }
  if (dataCopyDir) rmSync(dataCopyDir, { recursive: true, force: true });
}
process.on("exit", killEverything);
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(sig, () => {
    killEverything();
    process.exit(130);
  });
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

const shots: string[] = [];
const results: Array<{ ok: boolean; soft: boolean; label: string; detail?: string }> = [];
let phase = "start";

function check(label: string, ok: boolean, detail?: string, soft = false) {
  results.push({ ok, soft, label, detail });
  const mark = ok ? "PASS" : soft ? "WARN" : "FAIL";
  console.log(`  [${mark}] ${label}${detail ? ` - ${detail}` : ""}`);
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.once("error", rej);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => res(port));
    });
  });
}

async function answers(url: string): Promise<number | null> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return r.status;
  } catch {
    return null;
  }
}

function newestMtime(dir: string, skip = new Set(["node_modules", ".output", ".wxt", "dist", ".git"])): number {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const full = join(dir, entry.name);
    const t = entry.isDirectory() ? newestMtime(full, skip) : statSync(full).mtimeMs;
    if (t > newest) newest = t;
  }
  return newest;
}

function hasSnaps(dataDir: string): boolean {
  try {
    return readdirSync(join(dataDir, "snaps")).length > 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 1. Precheck: the build
// ---------------------------------------------------------------------------

console.log(`Output directory: ${OUT}\n`);

if (flag("build")) {
  console.log("Building the extension (npx -y pnpm@10.11.1 build)...");
  const b = spawnSync("npx", ["-y", "pnpm@10.11.1", "build"], { cwd: REPO, stdio: "inherit" });
  if (b.status !== 0) {
    console.error("Build failed.");
    process.exit(1);
  }
}
if (!existsSync(join(EXT, "manifest.json"))) {
  console.error(
    `No built extension at ${EXT}.\nRun: npx -y pnpm@10.11.1 build   (or re-run this script with --build)`,
  );
  process.exit(1);
}
if (!existsSync(CHROME)) {
  console.error(`Chrome not found at ${CHROME}. Set CHROME_PATH.`);
  process.exit(1);
}
{
  const built = statSync(join(EXT, "manifest.json")).mtimeMs;
  const src = Math.max(
    newestMtime(join(REPO, "apps/extension"), new Set(["node_modules", ".output", ".wxt", "dist", ".git"])),
    newestMtime(join(REPO, "packages/agent-core")),
  );
  if (src > built) {
    console.log(
      "WARNING: the build is older than the source. Screenshots may not show your change.\n" +
        "         Re-run with --build (or: npx -y pnpm@10.11.1 build).\n",
    );
  }
}

// ---------------------------------------------------------------------------
// 2. Amber, read-only, on its own port
// ---------------------------------------------------------------------------

const codeDir = resolve(arg("amber-dir") ?? DEFAULT_AMBER);
const python = resolve(arg("python") ?? join(codeDir, ".venv/bin/python"));
const dataSource = resolve(arg("data-from") ?? join(codeDir, "data"));

if (!existsSync(python)) {
  console.error(`No Python at ${python}. Pass --amber-dir <checkout> (with a .venv) or --python <interpreter with Amber's deps>.`);
  process.exit(1);
}
if (!existsSync(join(codeDir, "app/main.py"))) {
  console.error(`${codeDir} is not an Amber checkout (no app/main.py). Pass --amber-dir.`);
  process.exit(1);
}
if (!existsSync(dataSource)) {
  console.error(`No Amber data at ${dataSource}. Pass --data-from <data dir>.`);
  process.exit(1);
}
// Amber is started against a COPY: opening an article may POST /api/save, which writes.
dataCopyDir = mkdtempSync(join(tmpdir(), "verify-newtab-amber-data-"));
const dataDir = join(dataCopyDir, "data");
cpSync(dataSource, dataDir, { recursive: true });
if ((await answers(`${AMBER}/`)) !== null) {
  console.error(`Something already answers on ${AMBER}. Pick another --port; this script never reuses a server.`);
  process.exit(1);
}

console.log(`Amber code:  ${codeDir}`);
console.log(`Amber data:  ${dataDir}  (a copy of ${dataSource}; deleted on exit)`);
if (!hasSnaps(dataDir)) console.log("WARNING: that data dir has no snapshots, so the Library will be empty.");
console.log(`Amber check: ${AMBER}  (log in ${join(OUT, "amber.log")})\n`);

const amberLog = openSync(join(OUT, "amber.log"), "w");
amberProc = spawn(
  python,
  ["-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", String(AMBER_PORT)],
  { cwd: codeDir, env: { ...process.env, AMBER_DATA_DIR: dataDir }, stdio: ["ignore", amberLog, amberLog] },
);
closeSync(amberLog);

let noApi = false;

async function main() {
  // Wait for /api/snapshots to answer with anything.
  let status: number | null = null;
  for (let i = 0; i < 120; i++) {
    if (amberProc!.exitCode !== null) {
      throw new Error(`Amber exited early (code ${amberProc!.exitCode}). See ${join(OUT, "amber.log")}`);
    }
    status = await answers(`${AMBER}/api/snapshots?since_days=90&limit=1`);
    if (status !== null) break;
    await sleep(500);
  }
  if (status === null) throw new Error(`Amber never answered on ${AMBER}. See ${join(OUT, "amber.log")}`);
  if (status === 404) {
    noApi = true;
    console.log(
      "NOTE: this Amber has no /api/snapshots (404). Update it (git pull / use the json-api branch) and\n" +
        "      restart. Capturing the 'update and restart Amber' state; reader/search/chip shots are skipped.\n",
    );
  } else if (status !== 200) {
    throw new Error(`Amber answered /api/snapshots with HTTP ${status}.`);
  }
  const deadPort = await freePort();
  const DEAD = `http://127.0.0.1:${deadPort}`;

  // -------------------------------------------------------------------------
  // 3. Chrome with the extension
  // -------------------------------------------------------------------------
  const cdpPort = Number(arg("chrome-port") ?? (await freePort()));
  profileDir = mkdtempSync(join(tmpdir(), "verify-newtab-chrome-"));
  chromeProc = spawn(
    CHROME,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--enable-unsafe-extension-debugging",
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${profileDir}`,
      "about:blank",
    ],
    { stdio: "ignore", detached: true },
  );

  const getJson = async (path: string) =>
    (await fetch(`http://127.0.0.1:${cdpPort}${path}`)).json() as Promise<any>;

  type Cdp = Awaited<ReturnType<typeof cdp>>;
  async function cdp(wsUrl: string) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = rej;
    });
    let id = 0;
    const waiters = new Map<number, (v: any) => void>();
    const listeners = new Map<string, Array<(p: any) => void>>();
    ws.onmessage = (e) => {
      const msg = JSON.parse(String(e.data));
      if (msg.id && waiters.has(msg.id)) {
        waiters.get(msg.id)!(msg);
        waiters.delete(msg.id);
      } else if (msg.method) {
        for (const cb of listeners.get(msg.method) ?? []) cb(msg.params);
      }
    };
    const send = (method: string, params: unknown = {}) =>
      new Promise<any>((res, rej) => {
        const n = ++id;
        const timer = setTimeout(() => rej(new Error(`CDP ${method} timed out`)), 30_000);
        waiters.set(n, (m) => {
          clearTimeout(timer);
          res(m);
        });
        ws.send(JSON.stringify({ id: n, method, params }));
      });
    return {
      send,
      on(method: string, cb: (p: any) => void) {
        listeners.set(method, [...(listeners.get(method) ?? []), cb]);
      },
      close: () => ws.close(),
      async evaluate<T = any>(expression: string): Promise<T> {
        const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
        const ex = r.result?.exceptionDetails;
        if (ex) throw new Error(ex.exception?.description ?? JSON.stringify(ex).slice(0, 400));
        return r.result?.result?.value as T;
      },
    };
  }

  let version: any;
  for (let i = 0; i < 80 && !version; i++) {
    try {
      version = await getJson("/json/version");
    } catch {
      await sleep(250);
    }
  }
  if (!version) throw new Error("Chrome devtools endpoint never came up");
  console.log(`Browser: ${version.Browser}`);

  const browser = await cdp(version.webSocketDebuggerUrl);
  const loaded = await browser.send("Extensions.loadUnpacked", { path: EXT });
  const extId: string | undefined = loaded.result?.id;
  if (!extId) throw new Error(`Extensions.loadUnpacked failed: ${JSON.stringify(loaded)}`);
  console.log(`Extension id: ${extId}\n`);

  const targets: any[] = await getJson("/json/list");
  const blank = targets.find((t) => t.type === "page");
  if (!blank) throw new Error("no page target to drive");
  const page: Cdp = await cdp(blank.webSocketDebuggerUrl);
  await page.send("Runtime.enable");
  await page.send("Page.enable");
  await page.send("Log.enable");
  // A fresh profile defaults archiveUrl to the live Amber on :8080. This script never talks
  // to it: block it before the first page load, until archiveUrl points at the check instance.
  await page.send("Network.enable");
  await page.send("Network.setBlockedURLs", {
    urls: ["http://127.0.0.1:8080/*", "http://localhost:8080/*", "http://[::1]:8080/*"],
  });
  await page.send("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 900,
    deviceScaleFactor: 2,
    mobile: false,
  });

  // Console errors from the extension page, tagged with the phase they happened in.
  const consoleErrors: Array<{ phase: string; text: string }> = [];
  page.on("Runtime.exceptionThrown", (p) =>
    consoleErrors.push({
      phase,
      text: p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? "exception",
    }),
  );
  page.on("Runtime.consoleAPICalled", (p) => {
    if (p.type === "error") {
      const text = (p.args ?? []).map((a: any) => a.value ?? a.description ?? "").join(" ");
      consoleErrors.push({ phase, text });
    }
  });
  page.on("Log.entryAdded", (p) => {
    if (p.entry?.level === "error") consoleErrors.push({ phase, text: p.entry.text });
  });

  // ---- UI drivers: real mouse and key events ------------------------------
  const KEYS: Record<string, { code: string; vk: number }> = {
    Enter: { code: "Enter", vk: 13 },
    Escape: { code: "Escape", vk: 27 },
    "/": { code: "Slash", vk: 191 },
  };
  async function key(k: string) {
    const d = KEYS[k];
    for (const type of ["keyDown", "keyUp"]) {
      await page.send("Input.dispatchKeyEvent", {
        type,
        key: k,
        code: d.code,
        windowsVirtualKeyCode: d.vk,
        text: type === "keyDown" && k.length === 1 ? k : undefined,
      });
    }
  }
  /** Click the first element matching `selector` (and containing `text`) with a real mouse press. */
  async function click(selector: string, text?: string): Promise<boolean> {
    const pos = await page.evaluate<{ x: number; y: number } | null>(`(() => {
      const els = [...document.querySelectorAll(${JSON.stringify(selector)})];
      const el = ${text ? `els.find((e) => (e.textContent || "").includes(${JSON.stringify(text)}))` : "els[0]"};
      if (!el) return null;
      el.scrollIntoView({ block: "center", inline: "nearest" });
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    if (!pos) return false;
    await sleep(60);
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
      await page.send("Input.dispatchMouseEvent", {
        type,
        x: pos.x,
        y: pos.y,
        button: type === "mouseMoved" ? "none" : "left",
        clickCount: type === "mouseMoved" ? 0 : 1,
      });
    }
    return true;
  }
  async function waitFor(expr: string, label: string, timeoutMs = 12_000): Promise<boolean> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      try {
        if (await page.evaluate<boolean>(`Boolean(${expr})`)) return true;
      } catch {
        /* page navigating */
      }
      await sleep(120);
    }
    console.log(`  (timed out waiting for: ${label})`);
    return false;
  }
  async function shot(name: string) {
    await sleep(250);
    const r = await page.send("Page.captureScreenshot", { format: "png" });
    const file = join(OUT, `${name}.png`);
    writeFileSync(file, Buffer.from(r.result.data, "base64"));
    shots.push(file);
  }
  const newtabUrl = `chrome-extension://${extId}/newtab.html`;
  async function load() {
    const nav = await page.send("Page.navigate", { url: newtabUrl });
    if (nav.result?.errorText) throw new Error(`navigate failed: ${nav.result.errorText}`);
    await waitFor(`location.href.startsWith("chrome-extension://") && document.readyState === "complete"`, "page load");
    await waitFor(`document.querySelector(".shell")`, "app mount");
  }
  const setStorage = (o: object) => page.evaluate(`chrome.storage.local.set(${JSON.stringify(o)})`);
  const rowCount = () => page.evaluate<number>(`document.querySelectorAll(".view-library .row").length`);
  const libraryReady = (ms = 15_000) =>
    waitFor(
      `document.querySelector(".view-library .row") || document.querySelector(".view-library .notice")`,
      "library rows or notice",
      ms,
    );
  const snapshotCount = () => {
    try {
      return readdirSync(join(dataDir, "snaps")).length;
    } catch {
      return 0;
    }
  };
  const text = (selector: string) =>
    page.evaluate<string>(`document.querySelector(${JSON.stringify(selector)})?.textContent || ""`);

  // Fresh profile: first load, then point the archive at the check instance.
  await load();
  await setStorage({ archiveUrl: AMBER });

  // ---- Latest fixtures --------------------------------------------------------
  // A local feed whose first item is an article Amber already has (so the "In Amber"
  // marker and the no-save open path are deterministic) and whose second is not.
  let hasSaveApi = false;
  {
    const status = await answers(`${AMBER}/api/lookup?url=${encodeURIComponent("https://example.com/")}`);
    hasSaveApi = status === 200;
  }
  const archivedFixture = await (async () => {
    try {
      const r = await fetch(`${AMBER}/api/snapshots?since_days=365&limit=1`);
      const j = (await r.json()) as any;
      const snap = j.snapshots?.[0];
      return snap ? { title: String(snap.title), link: String(snap.final_url ?? snap.url), id: String(snap.id) } : null;
    } catch {
      return null;
    }
  })();
  const FIXTURE_NOT_SAVED = "https://example.com/verify-newtab-fixture-not-archived";
  const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const fixtureXml = () => {
    const at = new Date().toUTCString();
    const items = [
      archivedFixture && { title: archivedFixture.title, link: archivedFixture.link, d: "From the fixture feed: already in the archive." },
      { title: "Fixture story that is not in the archive yet", link: FIXTURE_NOT_SAVED, d: "From the fixture feed: Amber has never seen this address." },
    ].filter(Boolean) as Array<{ title: string; link: string; d: string }>;
    return `<?xml version="1.0"?><rss version="2.0"><channel><title>Verify fixture</title>${items
      .map((i) => `<item><title>${esc(i.title)}</title><link>${esc(i.link)}</link><pubDate>${at}</pubDate><description>${esc(i.d)}</description></item>`)
      .join("")}</channel></rss>`;
  };
  fixtureServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(fixtureXml(), { headers: { "content-type": "application/rss+xml" } }),
  });
  const FIXTURE_FEED = `http://127.0.0.1:${fixtureServer.port}/feed.xml`;
  const LIVE_SAVE_FEEDS = [
    { id: "guardian", name: "The Guardian", feedUrls: ["https://www.theguardian.com/world/rss"], enabled: true },
    { id: "ars-technica", name: "Ars Technica", feedUrls: ["https://feeds.arstechnica.com/arstechnica/index"], enabled: true },
    { id: "bbc", name: "BBC News", feedUrls: ["https://feeds.bbci.co.uk/news/world/rss.xml"], enabled: true },
  ];
  const SAVE_SOURCES = LIVE_SAVE_FEEDS.map((s) => s.name);
  const latestReady = (ms = 40_000) =>
    waitFor(
      `document.querySelector(".view-latest .row") || document.querySelector(".view-latest .notice")`,
      "latest rows or notice",
      ms,
    );
  /** Open Latest's first row matching `where` (a JS predicate over the row element) and return its id. */
  const rowId = (where: string) =>
    page.evaluate<string | null>(`(() => {
      const row = [...document.querySelectorAll(".view-latest .row")].find((r) => (${where})(r));
      return row ? row.id : null;
    })()`);
  let savedRowTitle = "";
  let savedRowId = "";

  // ---- The Latest flow, one theme at a time ---------------------------------------
  let latestSavedOnce = false;
  async function latestFlow(theme: "dark" | "light") {
    // 08 Latest, as seeded from the archive's sources --------------------------
    phase = `${theme}:latest`;
    const before = snapshotCount();
    await waitFor(`document.querySelector(".view-latest")`, "latest pane");
    await latestReady();
    const seeded = await page.evaluate<any>(`(() => ({
      rows: document.querySelectorAll(".view-latest .row").length,
      chips: [...document.querySelectorAll(".view-latest .chips .chip")].map((c) => c.textContent.trim()),
      active: document.querySelector(".tab.active")?.textContent.trim(),
      updated: document.querySelector(".view-latest .lib-head .meta")?.textContent || "",
    }))()`);
    check("Latest is the default tab", seeded.active === "Latest", String(seeded.active));
    check("Latest has rows from the live feeds", seeded.rows > 0, `${seeded.rows} rows`);
    check("Latest has source chips with counts", seeded.chips.length > 1 && /\d/.test(seeded.chips[0]), seeded.chips.slice(0, 5).join(" | "));
    check("Latest says when it was updated", /^Updated /.test(seeded.updated), seeded.updated);
    check("Loading Latest saved nothing to Amber", snapshotCount() === before, `${before} -> ${snapshotCount()} snapshots`);
    await shot(`08-latest-${theme}`);

    // Add the fixtures once; every later pass reuses what is in storage.
    if (theme === "dark" || !latestSavedOnce) {
      const stored = await page.evaluate<any[]>(`chrome.storage.local.get("sources").then((r) => r.sources || [])`);
      check("The sources catalog was seeded and stored", stored.length > 0, `${stored.length} sources`);
      const fixtureSource = { id: "verify-fixture", name: "Verify fixture", feedUrls: [FIXTURE_FEED], enabled: true };
      const extra = [fixtureSource, ...LIVE_SAVE_FEEDS].filter((x) => !stored.some((s: any) => s.id === x.id));
      await setStorage({ sources: [...stored, ...extra] });
      await load();
      await latestReady();
    }

    // 09 Marker for an archived item, source chip, search ----------------------
    phase = `${theme}:latest-chip`;
    await waitFor(`document.querySelectorAll(".view-latest .chips .chip").length > 3`, "chips after reload");
    if (archivedFixture) {
      await waitFor(`document.querySelector(".view-latest .row-amber")`, "In Amber marker", 15_000);
      const marked = await page.evaluate<string[]>(
        `[...document.querySelectorAll(".view-latest .row")].filter((r) => r.querySelector(".row-amber")).map((r) => r.querySelector(".row-title").textContent)`,
      );
      check(
        'An archived story is marked "In Amber"',
        marked.includes(archivedFixture.title),
        `${marked.length} marked; fixture "${archivedFixture.title.slice(0, 50)}"`,
      );
    } else {
      check('An archived story is marked "In Amber"', false, "Amber has no usable snapshot to build a fixture from", true);
    }
    const total = await page.evaluate<number>(`document.querySelectorAll(".view-latest .row").length`);
    // The fixture source sits at the end of the catalog, behind "N more".
    if (!(await page.evaluate<boolean>(`!![...document.querySelectorAll(".view-latest .chips .chip")].find((c) => c.textContent.includes("Verify fixture"))`))) {
      await click(".view-latest .chips .chip.more");
      await sleep(150);
    }
    await click(".view-latest .chips .chip", "Verify fixture");
    await sleep(200);
    const filtered = await page.evaluate<string[]>(
      `[...new Set([...document.querySelectorAll(".view-latest .row .row-site")].map((e) => e.textContent))]`,
    );
    check("A Latest source chip filters the stream", filtered.length === 1 && filtered[0] === "Verify fixture", filtered.join(", "));
    await shot(`09-latest-source-chip-${theme}`);
    await click(".view-latest .chips .chip", "All");
    await sleep(150);

    await key("/");
    await page.send("Input.insertText", { text: "fixture" });
    await sleep(250);
    const found = await page.evaluate<number>(`document.querySelectorAll(".view-latest .row").length`);
    check("Latest search narrows the stream", found > 0 && found < total, `${found} of ${total}`);
    await key("Escape");
    await sleep(200);
    await key("Escape");

    // An archived story opens straight in the Reader, from the archive, without a save.
    if (archivedFixture) {
      phase = `${theme}:latest-archived-reader`;
      const snaps = snapshotCount();
      const id = await rowId(`(r) => r.querySelector(".row-amber") && r.querySelector(".row-title").textContent === ${JSON.stringify(archivedFixture.title)}`);
      if (id && (await click(`#${id}`))) {
        const ok = await waitFor(`document.querySelectorAll(".reader-body p").length > 3`, "archived story text");
        check("An archived Latest story reads straight from Amber", ok);
        const back = await text(".reader-bar .back-btn");
        const pos = await text(".reader-bar .bar-pos");
        check('The Reader names where it came from and walks the Latest list', /Latest/.test(back) && /\d+ of \d+/.test(pos), `${back.trim()} · ${pos.trim()}`);
        check("Opening an archived story saved nothing new", snapshotCount() === snaps);
        await key("Escape");
        await waitFor(`!document.querySelector(".reader")`, "reader to close");
        const focus = await page.evaluate<boolean>(`!!document.activeElement?.closest?.(".view-latest .row")`);
        check("Closing the Reader returns focus to its Latest row", focus, undefined, true);
      } else {
        check("An archived Latest story reads straight from Amber", false, "row not found");
      }
    }

    // 10/11 A live story that is not in Amber: save -> capture -> full text -----
    if (hasSaveApi && !flag("no-save")) {
      phase = `${theme}:latest-save`;
      if (!latestSavedOnce) {
        const pick = await rowId(
          `(r) => ${JSON.stringify(SAVE_SOURCES)}.includes(r.querySelector(".row-site")?.textContent) && !r.querySelector(".row-amber")`,
        );
        if (!pick) {
          check("A live Guardian/Ars/BBC story is available to open", false, "no such row in the feeds right now");
        } else {
          savedRowId = pick;
          savedRowTitle = await text(`#${pick} .row-title`);
          const snaps = snapshotCount();
          await click(`#${pick}`);
          const sawFetching = await waitFor(`document.querySelector(".reader-fetch")`, "fetching state", 10_000);
          check("The Reader shows the feed's summary while fetching", sawFetching && (await text(".reader-title")).length > 0, savedRowTitle.slice(0, 60));
          await waitFor(`/Capturing|queue|Saving/i.test(document.querySelector(".reader-fetch-stage")?.textContent || "")`, "a progress stage", 15_000);
          const stage = await text(".reader-fetch");
          console.log(`  [info] fetching state: ${stage.replace(/\s+/g, " ").trim()}`);
          await shot(`10-latest-fetching-${theme}`);
          const done = await waitFor(
            `document.querySelectorAll(".reader-body p").length > 3 || document.querySelector(".reader-notice")`,
            "full article or a failure",
            150_000,
          );
          const outcome = await page.evaluate<any>(`({
            paragraphs: document.querySelectorAll(".reader-body p").length,
            notice: document.querySelector(".reader-notice .notice-title")?.textContent || "",
            title: document.querySelector(".reader-title")?.textContent || "",
          })`);
          check("The full article arrived from Amber", done && outcome.paragraphs > 3, outcome.notice || `${outcome.paragraphs} paragraphs`);
          check("Opening a live story saved exactly one snapshot", snapshotCount() === snaps + 1, `${snaps} -> ${snapshotCount()}`);
          await shot(`11-latest-reader-fetched-${theme}`);
          latestSavedOnce = true;
          await key("Escape");
          await waitFor(`!document.querySelector(".reader")`, "reader to close");
          const marked = await page.evaluate<boolean>(`!!document.getElementById(${JSON.stringify(pick)})?.querySelector(".row-amber")`);
          check('The saved story shows "In Amber" without a reload', marked);
        }
      } else if (savedRowId) {
        // Light pass: the same story is in Amber now, so it opens from the archive.
        const id = await rowId(`(r) => r.querySelector(".row-title").textContent === ${JSON.stringify(savedRowTitle)}`);
        if (id && (await click(`#${id}`))) {
          const ok = await waitFor(`document.querySelectorAll(".reader-body p").length > 3`, "saved story text", 20_000);
          check("The story saved earlier now reads from Amber", ok);
          await shot(`11-latest-reader-fetched-${theme}`);
          await key("Escape");
          await waitFor(`!document.querySelector(".reader")`, "reader to close");
        }
      }
    } else if (!hasSaveApi) {
      check("Amber has the save API (/api/lookup)", false, "update Amber to a build with PR #17; the save flow was skipped", true);
    }

    // Optional: a paywalled publisher, to see what Amber's capture comes back with -----
    if (hasSaveApi && flag("probe-paywall") && theme === "dark") {
      phase = `${theme}:latest-probe`;
      const id = await rowId(
        `(r) => ["The New York Times", "Financial Times", "The Wall Street Journal"].includes(r.querySelector(".row-site")?.textContent) && !r.querySelector(".row-amber")`,
      );
      if (id && (await click(`#${id}`))) {
        await waitFor(
          `document.querySelectorAll(".reader-body p").length > 3 || document.querySelector(".reader-notice")`,
          "paywalled capture to finish",
          150_000,
        );
        const out = await page.evaluate<any>(`({
          paragraphs: document.querySelectorAll(".reader-body p").length,
          note: document.querySelector(".reader-note")?.textContent || "",
          notice: document.querySelector(".reader-notice .notice-title")?.textContent || "",
          body: document.querySelector(".reader-notice .notice-body")?.textContent || "",
        })`);
        console.log(`  [info] paywalled probe: ${JSON.stringify(out)}`);
        await shot(`14-latest-probe-paywalled-${theme}`);
        await key("Escape");
        await waitFor(`!document.querySelector(".reader")`, "reader to close");
      } else {
        console.log("  [info] paywalled probe: no un-archived NYT/FT/WSJ row right now");
      }
    }

    // 12 Failure path: Amber stopped, open a story it has not got ---------------
    phase = `${theme}:latest-amber-down`;
    await setStorage({ archiveUrl: DEAD });
    await load();
    await latestReady();
    const fixtureRow = await rowId(`(r) => /not in the archive yet/.test(r.querySelector(".row-title").textContent)`);
    if (fixtureRow && (await click(`#${fixtureRow}`))) {
      const shown = await waitFor(`document.querySelector(".reader-notice")`, "failure notice", 25_000);
      const notice = await page.evaluate<any>(`({
        title: document.querySelector(".reader-notice .notice-title")?.textContent || "",
        actions: [...document.querySelectorAll(".reader-notice .ghost-btn")].map((b) => b.textContent.trim()),
        summary: !!document.querySelector(".reader-deck"),
      })`);
      check(
        "Amber stopped: a calm message with Try again and Open original",
        shown && /isn.t running/i.test(notice.title) && notice.actions.includes("Try again") && notice.actions.includes("Open original"),
        `${notice.title} [${notice.actions.join(", ")}]`,
      );
      check("The feed summary stays on screen when the fetch fails", notice.summary);
      await shot(`12-latest-reader-amber-down-${theme}`);
      await key("Escape");
      await waitFor(`!document.querySelector(".reader")`, "reader to close");
    } else {
      check("Amber stopped: a calm message with Try again and Open original", false, "fixture row not found");
    }
    await setStorage({ archiveUrl: AMBER });
    await load();
  }

  for (const theme of ["dark", "light"] as const) {
    console.log(`--- ${theme} ---`);
    await setStorage({ archiveUrl: AMBER });
    phase = `${theme}:library`;
    await load();

    // Switch theme with the real toggle button (it persists the choice).
    const current = await page.evaluate<string>(`document.documentElement.dataset.theme`);
    if (current !== theme) {
      await click(`button[aria-label="Switch to ${theme} theme"]`);
      await waitFor(`document.documentElement.dataset.theme === ${JSON.stringify(theme)}`, `theme ${theme}`);
      await load();
    }
    check(`theme is ${theme}`, (await page.evaluate<string>(`document.documentElement.dataset.theme`)) === theme);

    // ---- Latest (the default view) -----------------------------------------------
    await latestFlow(theme);

    // 01 Library ------------------------------------------------------------
    phase = `${theme}:library`;
    await click(".tab", "Library");
    await libraryReady();
    const total = await rowCount();
    if (noApi) {
      const notice = await page.evaluate<string>(`document.querySelector(".notice-title")?.textContent || ""`);
      check("Library shows the 'no article API' notice", /no article API/i.test(notice), notice);
    } else {
      check("Library has rows", total > 0, `${total} rows`);
    }
    await shot(`01-library-${theme}`);

    if (!noApi && total > 0) {
      // 02 Source chip ------------------------------------------------------
      phase = `${theme}:chip`;
      const chip = await page.evaluate<string | null>(`(() => {
        const c = [...document.querySelectorAll(".view-library .chips .chip")].find((b) => !b.classList.contains("more") && !b.classList.contains("empty") && !/^All/.test(b.textContent || ""));
        return c ? c.firstChild.textContent.trim() : null;
      })()`);
      if (chip && (await click(".view-library .chips .chip", chip))) {
        await sleep(200);
        const sites = await page.evaluate<string[]>(
          `[...new Set([...document.querySelectorAll(".view-library .row .row-site")].map((e) => e.textContent))]`,
        );
        const n = await rowCount();
        check(
          `source chip "${chip}" filters the list`,
          n > 0 && n <= total && sites.length === 1 && sites[0] === chip,
          `${n} of ${total} rows`,
        );
        await shot(`02-library-source-chip-${theme}`);
        await click(".view-library .chips .chip", "All");
        await sleep(150);
      } else {
        check("a source chip exists to click", false, "no chip found");
      }

      // 03 Search -----------------------------------------------------------
      phase = `${theme}:search`;
      const word = await page.evaluate<string>(`(() => {
        const titles = [...document.querySelectorAll(".view-library .row-title")].map((e) => e.textContent || "");
        const t = titles[Math.min(2, titles.length - 1)] || "";
        const words = t.split(/[^\\p{L}\\p{N}]+/u).filter((w) => w.length >= 5);
        return (words.sort((a, b) => b.length - a.length)[0] || t.split(" ")[0] || "the");
      })()`);
      await key("/");
      await sleep(100);
      const focused = await page.evaluate<boolean>(`document.activeElement?.type === "search"`);
      check('"/" focuses the search box', focused);
      await page.send("Input.insertText", { text: word });
      await sleep(250);
      const found = await rowCount();
      check(`search "${word}" narrows the list`, found > 0 && found <= total, `${found} of ${total} rows`);
      await shot(`03-library-search-${theme}`);
      await key("Escape");
      await sleep(200);
      check("Esc clears the search", (await rowCount()) === total, `${await rowCount()} rows`, true);
      await key("Escape");

      // 04 Reader -------------------------------------------------------------
      phase = `${theme}:reader`;
      await click(".view-library .row");
      const read = await waitFor(`document.querySelectorAll(".reader-body p").length > 0`, "reader body");
      await sleep(500);
      const reader = await page.evaluate<any>(`(() => {
        const scroller = document.querySelector(".reader-scroll");
        const ps = [...document.querySelectorAll(".reader-body p")];
        const body = ps.find((p) => !p.classList.contains("reader-note")) || ps[0];
        const out = { paragraphs: ps.length, scrollTop: scroller ? scroller.scrollTop : -1, title: document.querySelector(".reader-title")?.textContent || "" };
        const content = document.querySelector(".shell-content");
        out.shellInert = !!content && content.inert === true;
        out.topbarInert = !!document.querySelector(".topbar")?.closest("[inert]");
        if (body) {
          const cs = getComputedStyle(body);
          const probe = document.createElement("span");
          probe.style.cssText = "position:absolute;visibility:hidden;width:1ch;height:1px";
          body.appendChild(probe);
          const ch = probe.getBoundingClientRect().width;
          probe.remove();
          out.fontSize = cs.fontSize;
          out.fontFamily = cs.fontFamily.split(",")[0].replace(/["']/g, "");
          out.measureCh = Math.round((body.getBoundingClientRect().width / ch) * 10) / 10;
          const rgb = (s) => (s.match(/[\\d.]+/g) || []).slice(0, 3).map(Number);
          const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
          let el = body, bg = "rgba(0, 0, 0, 0)";
          while (el && /rgba\\(.*,\\s*0\\)|transparent/.test(bg)) { bg = getComputedStyle(el).backgroundColor; el = el.parentElement; }
          const fg = rgb(cs.color), bgc = rgb(bg);
          const [hi, lo] = [lum(fg), lum(bgc)].sort((a, b) => b - a);
          out.contrast = Math.round(((hi + 0.05) / (lo + 0.05)) * 10) / 10;
          out.bg = bg;
          out.fg = cs.color;
          out.accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
        }
        return out;
      })()`);
      check("Reader opened on the newest article", read && reader.title.length > 0, reader.title.slice(0, 70));
      check("Reader body has more than 3 paragraphs", reader.paragraphs > 3, `${reader.paragraphs} paragraphs`);
      check("Reader starts scrolled to the top", reader.scrollTop === 0, `scrollTop ${reader.scrollTop}`);
      check(
        "Top bar is inert while the Reader is open",
        reader.shellInert && reader.topbarInert,
        `.shell-content inert=${reader.shellInert}`,
      );
      console.log(
        `  [info] reader text: ${reader.fontSize} ${reader.fontFamily}, measure ${reader.measureCh}ch, ` +
          `contrast ${reader.contrast}:1, bg ${reader.bg}, accent ${reader.accent}`,
      );
      check("Reader font size is about 20px (18-22 accepted)", Math.abs(parseFloat(reader.fontSize) - 20) <= 2, reader.fontSize, true);
      check("Reader measure is about 62-70ch (60-72 accepted)", reader.measureCh >= 60 && reader.measureCh <= 72, `${reader.measureCh}ch`, true);
      check("Reader text contrast is at least 7:1", reader.contrast >= 7, `${reader.contrast}:1`, true);
      await shot(`04-reader-${theme}`);
      await key("Escape");
      await waitFor(`!document.querySelector(".reader")`, "reader to close");
      const focusBack = await page.evaluate<boolean>(`!!document.activeElement?.closest?.(".row")`);
      check("Closing the Reader returns focus to its row", focusBack, undefined, true);
    }

    // 05 Settings -----------------------------------------------------------
    phase = `${theme}:settings`;
    await click(".topbar button", "Settings");
    await waitFor(`document.querySelector(".modal")`, "settings modal");
    await waitFor(`document.querySelector("#set-archive") && !document.querySelector("#set-archive").disabled`, "archive field");
    const modal = await page.evaluate<any>(`(() => {
      const m = document.querySelector(".modal"), body = document.querySelector(".modal-body");
      const mr = m.getBoundingClientRect();
      const wide = [...m.querySelectorAll("*")].filter((e) => e.getBoundingClientRect().right > mr.right + 1).map((e) => e.className || e.tagName).slice(0, 3);
      return { modalOver: m.scrollWidth - m.clientWidth, bodyOver: body.scrollWidth - body.clientWidth, wide, url: document.querySelector("#set-archive").value };
    })()`);
    check(
      "Settings modal has no horizontal overflow",
      modal.modalOver <= 0 && modal.bodyOver <= 0 && modal.wide.length === 0,
      `modal +${modal.modalOver}px, body +${modal.bodyOver}px${modal.wide.length ? `, wide: ${modal.wide}` : ""}`,
    );
    check("Settings shows the check instance address", modal.url === AMBER, modal.url);
    await shot(`05-settings-${theme}`);
    await key("Escape");
    await waitFor(`!document.querySelector(".modal")`, "settings to close");

    // 06 Today, fresh profile ---------------------------------------------------
    phase = `${theme}:today`;
    await click(".tab", "Today");
    const gate = await waitFor(
      `/Connect your Anthropic API key/i.test(document.body.innerText)`,
      "API-key screen",
      6000,
    );
    check("Today shows the API-key screen on a fresh profile", gate);
    await shot(`06-today-empty-${theme}`);
    await click(".tab", "Library");

    // 07 Amber down ---------------------------------------------------------------
    phase = `${theme}:amber-down`;
    await setStorage({ archiveUrl: DEAD });
    await load();
    await click(".tab", "Library");
    const down = await waitFor(
      `/Amber isn.t running/i.test(document.querySelector(".view-library .notice-title")?.textContent || "")`,
      "'Amber isn't running' notice",
    );
    check("Library shows 'Amber isn't running' when the archive is unreachable", down, DEAD);
    await shot(`07-amber-down-${theme}`);

    // Back to dark/light switch: reset the address for the next pass.
    await setStorage({ archiveUrl: AMBER });
    phase = `${theme}:done`;
  }

  // homepage:open-url: a model-built page asks to open an address ----------------
  // A stored homepage whose one big button posts three messages: a javascript: URL, the
  // check Amber's own loopback address, and a real address. Only the last may open the
  // Reader, and nothing may be saved until "Fetch full article" is pressed.
  if (!flag("no-today-frame")) {
    phase = "open-url";
    console.log("--- homepage:open-url ---");
    const code = `import React from "react";
export default function App() {
  const send = (url) => window.parent.postMessage({ type: "homepage:open-url", url }, "*");
  return <button style={{ position: "fixed", inset: 0, width: "100%", fontSize: 28 }} onClick={() => {
    send("javascript:alert(1)");
    send(${JSON.stringify(AMBER + "/")});
    send(${JSON.stringify(FIXTURE_NOT_SAVED)});
  }}>open</button>;
}`;
    await setStorage({
      archiveUrl: AMBER,
      apiKey: "sk-ant-verify-newtab-not-a-real-key",
      autoRebuild: false,
      homepageData: { code, timestamp: new Date().toISOString() },
    });
    await load();
    await click(".tab", "Today");
    const frameUp = await waitFor(`document.querySelector(".today-frame iframe")`, "Today iframe", 20_000);
    check("Today renders the stored homepage in a frame", frameUp);
    if (frameUp) {
      await sleep(8000); // the preview bundler needs a moment before the button exists
      const snaps = snapshotCount();
      const box = await page.evaluate<{ x: number; y: number } | null>(`(() => {
        const r = document.querySelector(".today-frame iframe")?.getBoundingClientRect();
        return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
      })()`);
      if (box) {
        for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
          await page.send("Input.dispatchMouseEvent", {
            type,
            x: box.x,
            y: box.y,
            button: type === "mouseMoved" ? "none" : "left",
            clickCount: type === "mouseMoved" ? 0 : 1,
          });
        }
      }
      const opened = await waitFor(`document.querySelector(".reader .reader-title")`, "the Reader from homepage:open-url", 15_000);
      check("homepage:open-url opens the Reader on the address", opened);
      if (opened) {
        const state = await page.evaluate<any>(`({
          title: document.querySelector(".reader-title")?.textContent || "",
          button: !!document.querySelector(".reader-fetch.idle .solid-btn"),
          fetching: !!document.querySelector(".reader-fetch:not(.idle)"),
          back: document.querySelector(".reader-bar .back-btn")?.textContent.trim(),
          href: location.href,
        })`);
        check("The host stands in for the title, and nothing was fetched on its own", state.title === "example.com" && !state.fetching, `title "${state.title}"`);
        check('The Reader waits for "Fetch full article"', state.button);
        check("A javascript: or loopback address never opened anything", state.title === "example.com", state.title);
        check("The new tab was not navigated away", state.href.startsWith("chrome-extension://"), state.href);
        check("Nothing was saved to Amber by the message", snapshotCount() === snaps, `${snaps} -> ${snapshotCount()}`);
        await shot("13-today-open-url-reader");
      }
    }
    await page.evaluate(`chrome.storage.local.remove(["apiKey", "homepageData", "autoRebuild"])`);
  }

  // Console errors ---------------------------------------------------------------
  console.log("--- console ---");
  const noise = /Failed to load resource|ERR_CONNECTION|Failed to fetch|NetworkError|net::/i;
  const expected = (e: { phase: string; text: string }) =>
    noise.test(e.text) && (e.phase.endsWith("amber-down") || e.phase.endsWith("latest-probe") || noApi);
  const unexpected = consoleErrors.filter((e) => !expected(e));
  check(
    "No console errors from the extension page",
    unexpected.length === 0,
    unexpected.length
      ? unexpected
          .slice(0, 3)
          .map((e) => `[${e.phase}] ${e.text.slice(0, 140)}`)
          .join(" | ")
      : `${consoleErrors.length - unexpected.length} expected network error(s) ignored`,
  );

  page.close();
  browser.close();
}

let crashed = false;
try {
  await main();
} catch (err) {
  crashed = true;
  console.error(`\nFAILED during "${phase}": ${err instanceof Error ? err.stack ?? err.message : err}`);
} finally {
  killEverything();
  await sleep(500);
  if (profileDir) rmSync(profileDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

const hardFails = results.filter((r) => !r.ok && !r.soft);
const warns = results.filter((r) => !r.ok && r.soft);
console.log(`\nScreenshots (${shots.length}) in ${OUT}`);
for (const f of shots) console.log(`  ${f}`);
console.log(
  `\n${results.filter((r) => r.ok).length} passed, ${hardFails.length} failed, ${warns.length} warnings` +
    (crashed ? ", run aborted early" : "") +
    (noApi ? "  (Amber had no JSON API: reader/search/chip checks skipped)" : ""),
);
for (const r of hardFails) console.log(`  FAILED: ${r.label}${r.detail ? ` - ${r.detail}` : ""}`);
process.exit(crashed || hardFails.length ? 1 : 0);
