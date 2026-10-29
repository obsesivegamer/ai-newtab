# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Chrome MV3 extension that replaces the new-tab page with an agent-written homepage. The agent runs on Anthropic's managed-agent API (session + sandbox); the extension supplies browser-side tools (`getHistory`, `getPageHtml`), archive tools (`getArchive`, `getArchiveArticles`) backed by the user's local Amber server, and a live-news tool (`getFeeds`) that reads the RSS/Atom feeds of the user's sources straight from the browser. The new-tab page also has a deterministic **Latest** view (the same feeds, no model) and a Reader that can ask Amber to save a story and read it back. There is no server of ours. Read `ARCHITECTURE.md` before touching the build flow — its "Gotchas" section documents API behaviors that are easy to get wrong.

## Commands

pnpm workspace (pnpm 10.11.1; `npx pnpm@10.11.1 ...` works without a global install). Bun runs the harness and tests.

```bash
pnpm install
pnpm build            # extension → apps/extension/.output/chrome-mv3 (load unpacked in chrome://extensions)
pnpm dev              # WXT hot-reload dev build
pnpm typecheck        # tsc --noEmit across all workspaces
pnpm test             # bun test harness/ (history-digest, site-filter)
bun test harness/site-filter.test.ts   # single test file

pnpm web:build        # phone/web version -> apps/web/dist (served by Amber at /app/)
pnpm agent:run        # full real build via Node/Bun bridge — needs ANTHROPIC_API_KEY in .env, spends credits; reads Amber at AMBER_URL (default http://127.0.0.1:8080) and live feeds from FEEDS (comma-separated feed URLs; default: the archive's sources that we know feeds for, then the first 6 known publications)
pnpm agent:verify     # deliverable transpiles/evaluates/server-renders
pnpm agent:resume-test
pnpm agent:retention <sessionId>   # confirms session + uploads were deleted
pnpm extension:test   # headless Chrome check of the built extension (run `pnpm build` first; set CHROME_PATH if not default macOS path)
```

`.env` (see `.env.example`) is only for the harness (`ANTHROPIC_API_KEY`, `AMBER_URL`, `FEEDS`); the extension asks for the key in its UI. The archive address is the extension's `archiveUrl` setting (Settings → Article archive) or `AMBER_URL` for the harness. If Amber isn't up, start it with its own run script (or its launchd service).

## Architecture

Three workspaces:

- `packages/agent-core` — host-agnostic agent loop (`runHomepageBuild` in `orchestrator.ts`). **Must not import `chrome.*`, `browser.*`, or `node:*`**; the host injects a `BrowserBridge`, an optional `ArchiveBridge` and a `KVStore` (`types.ts`). Also holds the system prompt, tool schemas, history digesting, and the blocked-site filter.
- `apps/extension` — WXT + React. The service worker (`entrypoints/background.ts` → `lib/build-manager.ts`) hosts the build as a single-flight job, so builds survive closing the tab. New-tab pages are thin views that subscribe over a port (`lib/protocol.ts`) and get state snapshots + deltas. The finished homepage is model-written TSX, transpiled (`lib/transpile.ts`) and rendered in a Sandpack iframe — never in the extension page itself.
- `apps/web` — the phone/web version (Vite + React). Imports the extension's new-tab components/hooks/styles by alias (`@/` = `apps/extension`, `@newtab/` = its `entrypoints/newtab`); never copy them. Swaps only `@/lib/platform` (`IS_WEB`), `@/lib/browser-capture` (stub) and provides a `browser` shim. See "Phone/web version" below.
- `harness/` — Bun scripts that drive the same orchestrator with a fixture/fetch bridge (`node-bridge.ts`). It cannot see logged-in pages, which is why `getPageHtml` lives in the extension.

Key flows that span files:

- **Archive (Amber).** `lib/archive.ts` (`createArchiveBridge`) is the client for article data, used by the worker for builds and by the new-tab page for the Library/reader (Settings' connection test makes its own request). Extension reads try the Mac (`archiveUrl`) first and fail over to the offline reader (`fallbackArchiveUrl`, default `https://dell-plx-reader.tailf9612a.ts.net`; a stored `http://boxj:8081` or `http://dell-plx:8081` is rewritten only when the stored migration version is below 1, and `http://dell-plx-reader:8081` only when it is below 2, so version 2 keeps an explicit choice of any of them; any other saved address stays). A configured reader with no password is not called; the new tab says "Reader password not set" once. Settings stores the password when Test connection succeeds, and asks before closing a form that still has unsaved changes. Address cleanup is `normalizeArchiveUrl` in agent-core, shared with the harness. It is the *only* loopback access: `getPageHtml` still blocks loopback, and archive permalinks never go through `isAllowedUrl` (blocked sites are matched on each article's `originalUrl`). `harness/node-bridge.ts` replicates the mapping for Bun; don't import the extension from the harness.
- **Feeds and Latest.** Parsing, fetching (15 s per feed, 5 MB cap, no cookies, private-address redirects refused) and the bridge live in agent-core `feeds.ts` (`lib/feeds.ts` re-exports); the table of known publications and the seeding helpers are in `feed-catalog.ts` (WSJ reads Dow Jones' `feeds.content.dowjones.io` feeds, the old `feeds.a.dj.com` ones are frozen; the Washington Post reads `www.washingtonpost.com/arcio/rss/category/…` because `feeds.washingtonpost.com` answers 502; Reuters has no RSS, so `parseFeed` also reads its Google News sitemap; `loadSources` migrates stored catalogs, see ARCHITECTURE.md). The user's catalog is `lib/sources.ts` (chrome.storage, editable in Settings → Sources, seeded from the archive's `sources` and history). The Latest view (`newtab/components/Latest.tsx` + `useLatest.ts`) fetches in the *page*, per source, shows results as they arrive and keeps the last fetch in `chrome.storage.local` (`latestFeed`) so a new tab doesn't refetch; blocked sites are filtered by link host. Builds get the same feeds via `createFeedBridge(await loadSources())` in `build-manager.ts` (sources whose publisher is on the blocked list, or whose feed address is private, are skipped; Latest applies the same `isSourceBlocked` rule).
- **Saving to Amber (`lib/archive-save.ts`).** Besides reading, the extension calls Amber's `GET /api/lookup`, **`POST /api/save`**, `GET /api/jobs/{id}` (needs Amber PR #17 / the `save-api` branch). The rule: only a person's gesture on a story saves: a click/Enter on a Latest row, or the "Fetch full article" button. j/k/arrows/next-card and `homepage:open-url` only look up. Don't add an auto-save path.
- **Capture with my browser.** `lib/browser-capture.ts` (`captureWithBrowser`, `importFromBrowser`) loads one story in the signed-in browser and posts its raw HTML plus `final_url` to Amber's `POST /api/import` (`importPage` in `lib/archive-save.ts`). It is click-only (the Reader's one-shot `attemptRef.browser`, consumed at the top of the Reader effect), refuses blocked/private/non-http(s) addresses before opening a window, re-checks the page's address (allowed AND same site) before reading it, mutes and closes its window on every path, ends if the tab is closed, and never logs URLs or HTML. The raw HTML goes only to the configured Amber, not to Anthropic; the content script's `__rawDocument` flag (set by browser-capture, not by the model-facing scraper) is what makes it skip sanitizing. Don't call it from navigation, prefetch, a message or the build, and don't add permissions for it.
- **Custom tools run in the extension.** Anthropic emits `agent.custom_tool_use`; the worker executes it via `lib/browser-bridge.ts` (`history.ts`, `scraper.ts` + `entrypoints/scraper.content.ts`), uploads page HTML, and replies with `user.custom_tool_result`. Every tool call must get a result, even on error.
- **Worker keep-alive/resume:** a 1-minute `chrome.alarms` heartbeat calls `BuildManager.tick()`, which reattaches to a stored `activeSessionId` by replaying the session event log, and also triggers scheduled rebuilds (`lib/auto-rebuild.ts`). The tick claims the build and the reader-poll slot before any await, runs the scheduled check to completion, then asks the reader whether the phone wants a rebuild. The poll gate is 50s so the one-minute alarm actually polls about once a minute, and only when an API key is set and auto-rebuild is on. A phone request due in the same minute is remembered onto that one build. A wrong reader password is stored once; the banner is restored from that fingerprint across worker restarts while polling stays paused.
- **Privacy enforcement lives in agent-core tool handlers** (`site-filter.ts`), not just the prompt: blocked hosts are dropped from digests, blocked/non-HTTP(S) page requests never reach the bridge, scraped pages' final URL (post-redirect) is rechecked before upload, and loopback/private/local-network hosts are always blocked. Session and uploaded files are deleted in a `finally` at the end of every build.
- `chrome.storage` keys are centralized in `lib/storage.ts`; the new-tab UI prefs (theme, reader text size) have their own keys in `entrypoints/newtab/uiPrefs.ts`.

## Phone/web version

`apps/web` is the reader on a phone, served by Amber at `https://<mac>.<tailnet>.ts.net/app/` (same origin as Amber's API, so `archiveUrl = location.origin`).

- **Build:** `npx -y pnpm@10.11.1 web:build` → `apps/web/dist`, `base: "/app/"`.
- **Serve:** Amber with `AMBER_WEBAPP_DIR=<repo>/apps/web/dist` and `AMBER_ALLOWED_HOSTS=<mac>.<tailnet>.ts.net`, then `tailscale serve --bg --https=443 http://127.0.0.1:8080`. Never `tailscale funnel`.
- **Security model:** no login; tailnet-only. Anyone who can reach it can read and save to the archive.
- **Contracts with Amber:** `GET /api/feedproxy?url=` (feed XML), `GET/PUT /api/homepage` (`{code,timestamp,bytes}`, and `synced_at` plus optional `rebuild_request` on GET), `GET/PUT /api/sources` (`{sources:[{id,name,feedUrls,enabled}],updated_at}`), JSON-only PUTs. The reader also has authenticated `POST`/`GET /api/homepage/rebuild-request` (`{requested_at,id,fulfilled_at,baseline_timestamp,expired?,cooldown?}`; POST body is `{}`) and an authenticated `PUT /api/homepage` that accepts an equal timestamp, rejects an older one with 409, and rejects one more than 24h ahead with 422. Timestamps keep milliseconds. The phone reads `expired` from a GET (`rebuild_request` or the rebuild-request route), not from the POST body. Refresh POSTs only when the page is at least ~1h old; "Rebuild on Mac" POSTs unless that click already loaded a newer page. `GET /api/sources` on the reader includes `read_only: true` (a 405 means the same), and the phone then refuses source edits and puts the pre-edit list back. A 404 on the rebuild route hides Rebuild on Mac and says the reader has no rebuild route. `lib/phone-sync.ts` is the one client; the extension PUTs the homepage to the Mac after each successful build (when an archive address is set) and again to the fallback reader, and PUTs the sources when Settings saves them. From the extension, a request whose URL is the reader (homepage GET and PUT, sources GET and PUT, and the snapshots connection test) carries Basic `amber` and `redirect: "error"` when a password is set. The phone's same-origin calls and the Mac push do not. An empty password sends no header. All of it is best-effort, logged only, and the password is never logged.
- **Not on the phone:** Capture with my browser, running the model, history, blocked-sites editing. Today (`TodayStatic`) can ask the Mac to rebuild; it does not build the page itself. The preview mounts only when `window.isSecureContext` and `crypto.subtle` exist.
- **One gate:** the `homepage:open-article` / `homepage:open-url` rules live in `entrypoints/newtab/useHomepageOpen.ts`, shared by `App.tsx` and `WebApp.tsx`. Change them there only.
- **Extension changes must keep working on the web build:** shared code may use `browser.storage.local`/`history` (shimmed) but must gate anything else on `IS_WEB` from `@/lib/platform`, and `apps/web` must still typecheck (`pnpm typecheck` covers it).
- **Verify:** `~/Documents/amber-archive/.venv/bin/python .claude/skills/verify-newtab/scripts/verify-web.py --amber-dir <Amber checkout with the web routes> --out <dir>`; it uses a data COPY and port 8116, never :8080.

## Conventions

- Mounted page paths are re-rooted under `/mnt/session/uploads/`; always give the model `resource.mount_path` from the API response, not the path requested.
- Result events use `custom_tool_use_id` (not `tool_use_id`). Don't break the event loop on `session.status_idle` alone — see ARCHITECTURE.md.
- Don't ship to the Web Store as-is: the API key sits in `chrome.storage.local`.
