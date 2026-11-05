# Bugbot review rules

Chrome MV3 extension (`apps/extension`) plus a phone/web build (`apps/web`) that share code with it. Host-agnostic agent loop in `packages/agent-core`. Read `CLAUDE.md` and `ARCHITECTURE.md` for context. Report real bugs, privacy leaks and permission creep first.

## Secrets and sensitive data
- The Anthropic API key (`KEYS.apiKey` in `apps/extension/lib/storage.ts`, `Settings.apiKey`) must never appear in logs, thrown/UI error messages, `buildSnapshot`, port messages (`lib/protocol.ts`), the harness output, or anything sent to Amber. State carries `hasApiKey` (a boolean), never the key. Flag any `console.*` or `emit.log` that spreads `settings`, `client` or an SDK error object.
- Never log page HTML, article text, full story URLs or browsing history (`history.ts`, `scraper.ts`, `browser-capture.ts`, `archive-save.ts`). Log hosts or status codes only.
- Amber has no login. Anything pushed to it (`lib/phone-sync.ts`: homepage and sources) must go only to a host that passes `isShareableArchiveHost` / `shareTarget`. Flag any new request that sends reading data to a public address.

## Privacy enforcement lives in agent-core
- Blocked-site rules are enforced in the tool handlers (`packages/agent-core/orchestrator.ts`, `site-filter.ts`), not only the prompt. Every URL or host that reaches the bridge, the digest or an archive result must go through `isAllowedUrl` / `isBlocked`. The page's final URL (after redirects) must be re-checked before upload.
- Loopback/private hosts stay blocked (`isPrivateHost`). `getPageHtml` must not gain loopback access. Only `lib/archive.ts` may read the archive address.
- Feed fetches (`packages/agent-core/feeds.ts`) stay cookie-less (`credentials: "omit"`), size/time-capped, and must refuse redirects to private addresses.
- The session and uploaded files must be deleted in the orchestrator's `finally` on every exit path, including errors and aborts.

## Auth and error state
- Missing or rejected API key: `startBuild` in `lib/build-manager.ts` and `shouldAutoRebuild` (`lib/auto-rebuild.ts`) must stop. A failed or auto-attempted build must not loop (`lastAutoBuildAttempt`). A stale "no key" or error state must clear when a new key is saved via `saveSetting`, and must not clear on an unrelated setting.
- Every `agent.custom_tool_use` must get a `user.custom_tool_result`, even on error. A missing result hangs the session.
- Saving to Amber is user-gesture only (`archive-save.ts`, `browser-capture.ts`). Flag any auto-save path from navigation, prefetch, messages or the build. Capture-with-my-browser must stay click-only, re-check the address before reading, and close its window on every path.

## Permissions and code execution
- `apps/extension/wxt.config.ts` permissions and `host_permissions` should only grow with a clear need. Flag new permissions, new host patterns, `web_accessible_resources`, or loosened CSP.
- No `eval`, `new Function`, remote script loading, or rendering model output outside the Sandpack iframe. The homepage TSX is transpiled (`lib/transpile.ts`) and sandboxed, never run in the extension page. Scraped HTML must stay sanitized unless `__rawDocument` is set by browser-capture.
- Network calls go only to the Anthropic API, the configured `archiveUrl` (normalized via `normalizeArchiveUrl`), and the user's feed URLs. Flag hard-coded third-party hosts or analytics.

## Storage and compatibility
- Changes to `chrome.storage` keys (`KEYS` in `lib/storage.ts`, `lib/sources.ts`, `entrypoints/newtab/uiPrefs.ts`) must read old stored shapes safely (missing, renamed or wrongly typed values). Check `loadSettings` fallbacks, `sanitize`, `migrateRetiredFeeds`, `sourcesMigrated`, and `sourcesSyncStamp` / `if_updated_at` conflict handling in `phone-sync.ts`.
- Shared code must keep working on the web build: gate anything beyond `browser.storage.local`/`history` on `IS_WEB`. `packages/agent-core` must not import `chrome.*`, `browser.*` or `node:*`.
- MV3 worker lifecycle: state kept only in module variables is lost when the worker dies. Check the alarm heartbeat / `BuildManager.tick()` reattach path.

## Low priority / ignore
- Style, naming, formatting, import order, comment wording, and Markdown or doc nits.
- Missing tests for UI or glue code (tests are for pure logic only).
- Hand-written `ARCHITECTURE.md` prose, and CSS tweaks in `styles.css` that don't change behavior.
