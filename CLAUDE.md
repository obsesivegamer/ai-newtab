# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Chrome MV3 extension that replaces the new-tab page with an agent-written homepage. The agent runs on Anthropic's managed-agent API (session + sandbox); the extension supplies browser-side tools (`getHistory`, `getPageHtml`). There is no server. Read `ARCHITECTURE.md` before touching the build flow — its "Gotchas" section documents API behaviors that are easy to get wrong.

## Commands

pnpm workspace (pnpm 10.11.1; `npx pnpm@10.11.1 ...` works without a global install). Bun runs the harness and tests.

```bash
pnpm install
pnpm build            # extension → apps/extension/.output/chrome-mv3 (load unpacked in chrome://extensions)
pnpm dev              # WXT hot-reload dev build
pnpm typecheck        # tsc --noEmit across all workspaces
pnpm test             # bun test harness/ (history-digest, site-filter)
bun test harness/site-filter.test.ts   # single test file

pnpm agent:run        # full real build via Node/Bun bridge — needs ANTHROPIC_API_KEY in .env, spends credits
pnpm agent:verify     # deliverable transpiles/evaluates/server-renders
pnpm agent:resume-test
pnpm agent:retention <sessionId>   # confirms session + uploads were deleted
pnpm extension:test   # headless Chrome check of the built extension (run `pnpm build` first; set CHROME_PATH if not default macOS path)
```

`.env` (see `.env.example`) is only for the harness; the extension asks for the key in its UI.

## Architecture

Three workspaces:

- `packages/agent-core` — host-agnostic agent loop (`runHomepageBuild` in `orchestrator.ts`). **Must not import `chrome.*`, `browser.*`, or `node:*`**; the host injects a `BrowserBridge` and `KVStore` (`types.ts`). Also holds the system prompt, tool schemas, history digesting, and the blocked-site filter.
- `apps/extension` — WXT + React. The service worker (`entrypoints/background.ts` → `lib/build-manager.ts`) hosts the build as a single-flight job, so builds survive closing the tab. New-tab pages are thin views that subscribe over a port (`lib/protocol.ts`) and get state snapshots + deltas. The finished homepage is model-written TSX, transpiled (`lib/transpile.ts`) and rendered in a Sandpack iframe — never in the extension page itself.
- `harness/` — Bun scripts that drive the same orchestrator with a fixture/fetch bridge (`node-bridge.ts`). It cannot see logged-in pages, which is why `getPageHtml` lives in the extension.

Key flows that span files:

- **Custom tools run in the extension.** Anthropic emits `agent.custom_tool_use`; the worker executes it via `lib/browser-bridge.ts` (`history.ts`, `scraper.ts` + `entrypoints/scraper.content.ts`), uploads page HTML, and replies with `user.custom_tool_result`. Every tool call must get a result, even on error.
- **Worker keep-alive/resume:** a 1-minute `chrome.alarms` heartbeat calls `BuildManager.tick()`, which reattaches to a stored `activeSessionId` by replaying the session event log, and also triggers scheduled rebuilds (`lib/auto-rebuild.ts`).
- **Privacy enforcement lives in agent-core tool handlers** (`site-filter.ts`), not just the prompt: blocked hosts are dropped from digests, blocked/non-HTTP(S) page requests never reach the bridge, scraped pages' final URL (post-redirect) is rechecked before upload, and loopback/private/local-network hosts are always blocked. Session and uploaded files are deleted in a `finally` at the end of every build.
- All `chrome.storage` keys are centralized in `lib/storage.ts`.

## Conventions

- Mounted page paths are re-rooted under `/mnt/session/uploads/`; always give the model `resource.mount_path` from the API response, not the path requested.
- Result events use `custom_tool_use_id` (not `tool_use_id`). Don't break the event loop on `session.status_idle` alone — see ARCHITECTURE.md.
- Don't ship to the Web Store as-is: the API key sits in `chrome.storage.local`.
