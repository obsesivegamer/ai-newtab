# Architecture

There is no server. Three parties are involved, and you run one of them.

| | Runs where | Does what |
|---|---|---|
| **Extension** (service worker) | Your browser | Hosts the build: holds the SSE stream, executes `getHistory` / `getPageHtml`, uploads page HTML, persists the homepage |
| **Extension** (new-tab page(s)) | Your browser | Thin view: subscribes to the worker over a port, renders live progress and the finished homepage |
| **Amber** (optional) | Your Mac, `127.0.0.1:8080` | Your saved-article archive. Read-only JSON API: article list and full text |
| **Your sources' feeds** (optional) | The publishers, fetched from your browser | The newest articles from the sites you read: title, link, time, blurb. No article text |
| **Orchestration layer** | Anthropic | Runs the agent loop, persists the session event log, emits `agent.custom_tool_use` |
| **Session sandbox** | Anthropic | Runs `read` / `grep` / `glob` / `write` over the mounted pages |

The agent loop runs **in the service worker** (`apps/extension/lib/build-manager.ts`), so a build
survives closing the tab, shows up in every open tab, and can run headless on a
`chrome.alarms` schedule. The custom tools execute in the extension too, because they
need `chrome.history`, `chrome.tabs` and the local Amber server. Anthropic never executes them — it emits an event
and waits for a `user.custom_tool_result` on the same authenticated stream. There is no
inbound connection and no public endpoint.

```
service worker        Anthropic loop        sandbox
    │                       │                  │
    ├─ sessions.create ────▶│                  │
    ├─ events.stream ──────▶│  (open first)    │
    ├─ user.message ───────▶│                  │
    │◀─ custom_tool_use ────┤  getFeeds        │
    ├─ GET each feed (publishers, no cookies)  │
    ├─ custom_tool_result ─▶│                  │
    │◀─ custom_tool_use ────┤  getArchive      │
    ├─ GET /api/snapshots (Amber, 127.0.0.1)   │
    ├─ custom_tool_result ─▶│                  │
    │◀─ custom_tool_use ────┤  getArchiveArticles
    ├─ GET /api/snapshots/<id>/text (Amber)    │
    ├─ files.upload + resources.add ───────────▶  mounts /mnt/session/uploads/archive/<id>-<last 8 of upload id>.txt
    ├─ custom_tool_result ─▶│                  │
    │◀─ custom_tool_use ────┤  getHistory      │
    ├─ chrome.history ──────┤                  │
    ├─ custom_tool_result ─▶│                  │
    │◀─ custom_tool_use ────┤  getPageHtml     │
    ├─ tabs + scripting     │                  │
    ├─ files.upload ───────────────────────────▶
    ├─ resources.add ──────────────────────────▶  mounts /mnt/session/uploads/pages/*.html
    ├─ custom_tool_result ─▶│                  │
    │                       ├─ grep / read ───▶│
    │◀─ agent.message ──────┤                  │
    │◀─ status_idle ────────┤  end_turn        │
    ├─ files.list(scope_id) ───────────────────▶  /mnt/session/outputs/homepage.tsx
    └─ sessions.delete ────▶│                  │
```

### Keeping the worker alive

An MV3 service worker is torn down after ~30s idle, and a build spends most of its
wall clock waiting on the model. Three things keep it alive or bring it back:

- **During a turn**, the in-flight session fetch plus a 20s self-ping
  (`runtime.getPlatformInfo`) reset the idle timer.
- **A 1-minute alarm heartbeat** calls `BuildManager.tick()`. If an
  `activeSessionId` is in storage, the worker reattaches: the orchestrator replays
  the session's event log, re-answers any tool call left hanging, and finishes.
- **The same heartbeat** drives scheduled rebuilds (`lib/auto-rebuild.ts`), so the
  first new tab of the day already shows a fresh homepage.

### Tabs are views

Each new tab connects on a port (`lib/protocol.ts`), receives a snapshot of the
build state, then streams phase/text/log deltas. Every open tab shows the same live
run. A throttled snapshot is also mirrored to storage so a tab opened while the
worker is asleep paints instantly.

The finished component renders inside a Sandpack iframe
(`entrypoints/newtab/components/HomepagePreview.tsx`): it is model-written code, so
it runs sandboxed, not in the extension's own page.

**`homepage:open-article` contract.** The model-written page opens an archived story
in the native reader with `window.parent.postMessage({ type: "homepage:open-article",
id }, "*")`. The new-tab page (`entrypoints/newtab/App.tsx`) accepts it only when
`type` is exactly `"homepage:open-article"`, `id` is a string matching
`/^[A-Za-z0-9]{3,16}$/` (the same shape the archive tools accept), and the message's
`source` is the `contentWindow` of an iframe inside `.today-frame`, the Today
tab's Sandpack frame. Anything else is ignored. The prompt in
`packages/agent-core/prompt.ts` tells the model to emit exactly this.

**`homepage:open-url` contract.** For a story from `getFeeds` that is not in the
archive there is no snapshot id, so the model-written page sends
`window.parent.postMessage({ type: "homepage:open-url", url: item.link }, "*")`
(the item's `link`, verbatim). The new-tab page accepts it under the same sender
rule as above (`source` is the `contentWindow` of an iframe inside `.today-frame`)
and only when `type` is exactly `"homepage:open-url"` and `url` is a string that
parses as an `http:` or `https:` URL. It then opens the Reader on that URL: the
Reader shows the feed's title and summary at once, and fetches the full text by
saving the URL to Amber (on that click only) and reading the snapshot. Anything
that fails the checks is ignored. Stories the user already saved keep using
`homepage:open-article`; the prompt tells the model to match a feed item to an
archived story when its `link` equals the story's `originalUrl` after dropping
the `?query` and `#fragment`.

## Layout

```
packages/agent-core/      host-agnostic agent loop — imports no chrome.*, browser.*, or node:*
  orchestrator.ts         runHomepageBuild: session lifecycle, event loop, tool dispatch, cleanup
  setup.ts                ensureAgent / ensureEnvironment (created once, cached by ID)
  prompt.ts               system prompt + per-build kickoff message
  schemas.ts              custom tool input schemas (getFeeds, getArchive, getArchiveArticles, getHistory, getPageHtml) and defaults
  history-digest.ts       narrows raw history to fit a tool result
  archive-url.ts          normalizeArchiveUrl / archiveHostOf: archive address cleanup shared by the extension and harness
  types.ts                BrowserBridge, ArchiveBridge, FeedBridge, KVStore, RunPhase, …

apps/extension/           MV3 extension (WXT + React)
  entrypoints/
    background.ts         service worker: hosts BuildManager, alarm heartbeat
    scraper.content.ts    injected into scraped tabs: scroll, return HTML
    newtab/               the new-tab UI (thin client onto the worker)
  lib/
    build-manager.ts      single-flight build host, broadcast, keepalive, reattach
    browser-bridge.ts     BrowserBridge over chrome.history / chrome.tabs
    archive.ts            ArchiveBridge over fetch to Amber's JSON API; shared by the worker and the new-tab page
    history.ts            getHistory: group and rank chrome.history by domain
    scraper.ts            getPageHtml: load URLs in a background window, sanitize HTML
    protocol.ts           page ↔ worker messages and the five UI build steps
    auto-rebuild.ts       when to rebuild on a schedule
    storage.ts            chrome.storage keys, settings (incl. archiveUrl), saved homepage
    transpile.ts          TSX → JS for the preview

harness/                  Bun scripts: drive agent-core with a fixture/fetch bridge (and an
                          Amber ArchiveBridge reading AMBER_URL), test the extension
```

## Live feeds (`getFeeds`)

The archive is what the user saved; the feeds are what is new. The host supplies a
`FeedBridge` (`types.ts`), passed to `runHomepageBuild` as the optional `feeds`; it
fetches the user's sources' RSS/Atom feeds from the browser and returns
`FeedItem`s. Without a bridge, `getFeeds` answers with an error result and the
model falls back to the archive-first flow; the kickoff message says which of feeds
and archive exist, so the model usually does not even try.

| Tool | Does |
|---|---|
| `getFeeds` | Input `sinceHours` (1-72, default 24) and `perSource` (1-15, default 8). Returns `{ fetchedAt, sources: [{ name, count, error? }], items: [{ id, title, link, source, publishedAt?, summary?, author?, section? }] }`, newest first, at most 60 items, at most `perSource` per publication. Headline and blurb only, never article text. |

What the handler does on top of the bridge:

- **Blocklist on the link.** Each item's `link` goes through `isAllowedUrl`, so a
  blocked host, a private or local-network host and any non-HTTP(S) link are
  dropped. `sources[].count` is reduced by what was dropped from that publication;
  a publication left with nothing, and no feed error, is not mentioned at all. The
  model is never told blocked material existed (same rule as history and archive).
- **Untrusted text.** Titles, summaries, authors, sections, ids and links come from
  the open web. Titles and summaries are collapsed to one line and summaries are cut
  at 400 characters; the prompt tells the model to treat all of it as data and to use
  a `link` only verbatim as an `href` or message `url`. `publishedAt` is kept only
  when it starts with an ISO date.
- **Allow-list for `getPageHtml`.** The surviving items' link hosts are added to
  the run's `seenHosts`, so the model may load an item's page in the user's browser
  (it still counts against the live-page cap, and is checked again after redirects).
  A host the model only read inside a title or summary is not on the list.
- **Reattach.** `restoreFromHistory` reads the `link` of every `items[]` entry back
  out of each answered, non-error `getFeeds` result, so the allow-list survives a
  kill like the archive's and history's do.
- **Errors.** Like every tool, `getFeeds` always sends one result: a missing bridge or
  a bridge that throws becomes an `is_error` result starting "The live feeds are
  unavailable". One feed failing is not an error: it shows up in `sources[].error`.

The build phase reuses `history` (`feeds <n>h` as the detail), like `getArchive`.

## The article archive (Amber)

Amber is a separate local app that saves readable copies of articles. This fork's
agent leads with it. The host supplies an `ArchiveBridge` (`types.ts`), passed to
`runHomepageBuild` as `archive`; the extension builds it in `lib/archive.ts` from
the `archiveUrl` setting (default `http://127.0.0.1:8080`, empty disables it), and
the harness builds an equivalent one from `AMBER_URL`. Without a bridge the
archive tools answer with an error result and the build runs on history alone.

| Tool | Does |
|---|---|
| `getArchive` | Lists usable archived articles in a window (`sinceDays` 1-90, `limit` 1-60): metadata, permalink, per-publication counts. No bodies. |
| `getArchiveArticles` | Fetches up to 12 texts by id per call (24 mounted per build), cuts each to about 2,000 words for the model, uploads each as a text file (metadata header, blank line, body), mounts them under `/mnt/session/uploads/archive/`, and returns the *resolved* `mount_path`. The reader in the new tab always reads the full text. |

The bridge reads two endpoints and nothing else, both GET: `/api/snapshots?since_days=&limit=`
and `/api/snapshots/<id>/text`. Amber decides what is "usable" (complete, long enough,
real title), so failed paywall captures never reach the model.

**Loopback rule.** The archive bridge is the *only* loopback access in the system.
`getPageHtml` still blocks `127.0.0.1`, `localhost` and every private or local-network
host through `isAllowedUrl`, so the agent can't be steered into fetching arbitrary
local services. Archive permalinks (`http://127.0.0.1:8080/<id>`) are never passed
through `isAllowedUrl`; instead the blocked-sites list is applied to each article's
`originalUrl` (the publisher's address), both when listing and again before upload.

**Reattach.** The worker's per-build memory (which archive articles are already
mounted, which hosts the model was shown) is not persisted. On a reattach the
orchestrator rebuilds it from the session event log: each answered
`user.custom_tool_result` is joined to the `agent.custom_tool_use` with the same
id, and the `getArchiveArticles` refs, `getHistory` domains and `getArchive`
original-URL hosts are read back out of it. The 24-per-build cap and file reuse
therefore survive a kill.

The same bridge also feeds the deterministic Library and reader in the new-tab page,
which call it directly and involve no model. The worker's build phases reuse the
existing ones: `getArchive` reports `history`, `getArchiveArticles` reports
`scraping` (see `BUILD_STEPS` in `lib/protocol.ts`).

## Verification

| Command | Proves |
|---|---|
| `pnpm test` | The history digest is capped, ranked, drops `urls[]`, reports `totalSitesSeen` |
| `pnpm agent:run` | Full build against the real API: tools, mounting, sandbox grep/read, deliverable, cleanup. Uses Amber at `AMBER_URL` when it is reachable |
| `pnpm agent:verify` | The deliverable transforms, evaluates and server-renders |
| `pnpm agent:resume-test` | A build killed with a tool call pending can be reattached and finished |
| `pnpm agent:retention <sessionId>` | The session and every uploaded page body are actually deleted |
| `pnpm extension:test` | In headless Chrome: worker registers, new tab renders, port protocol answers, `chrome.history` reads |

The `agent:*` commands need `ANTHROPIC_API_KEY` in `.env` and spend API credits. The
harness's bridge uses fixture history and a plain `fetch`, so it can't see
logged-in pages — that's the whole reason `getPageHtml` runs in your browser.

## Gotchas worth knowing

**`mount_path` is always re-rooted under `/mnt/session/uploads/`.** A leading `/` is
stripped, not honored — both at session-create time and via `resources.add()`:

| requested | resolved |
|---|---|
| `/workspace/pages/x.html` | `/mnt/session/uploads/workspace/pages/x.html` |
| `/mnt/session/uploads/x.html` | `/mnt/session/uploads/x.html` |
| *(omitted)* | `/mnt/session/uploads/<file_id>` |

Always report `resource.mount_path` from the response back to the model, never the
path you asked for, or it greps a file that isn't there.

**The result event field is `custom_tool_use_id`**, not `tool_use_id`. (`tool_use_id`
belongs to `user.tool_confirmation` and `user.tool_result`.)

**Never leave an `agent.custom_tool_use` unanswered.** Every path out of the handler
must send a result — a thrown error becomes a result with `is_error: true`, never a
reason to skip the send. An unanswered tool call idles the session forever.

**Don't break on `session.status_idle` alone.** The session idles every time it waits
for a tool result. Break only on `status_terminated`, or on `status_idle` where
`stop_reason.type !== "requires_action"`. And run the terminal check for *every* event,
including deduped ones — `continue`-ing on a duplicate can skip the terminal event that
arrived in the history fetch.

**`event_start` / `event_delta` stream events carry no `id`.** Skip them before dedupe.

**`files.upload()` takes no `purpose`.** Just `{ file }`.

## Privacy

The editable blocked-sites list is enforced in agent-core's tool handlers, not
just the prompt: blocked domains are excluded from history digests and their
counts, and blocked or non-HTTP(S) page requests never reach the browser bridge.
Archived articles are filtered the same way on their publisher URL, and feed items
on the host of their `link`; feed fetches go from the browser straight to the
publishers (no cookies), and nothing is saved to the archive except on an explicit
click in the Reader. What the
model sees of the archive is the listing (titles, authors, publisher URLs, save
dates and per-publication counts for up to 40 articles per `getArchive` call) and
the full text of the articles it asks for; the text is sent to the API in the same
way as scraped pages and deleted with the rest of the session's uploads.
Each scraped page's final URL is checked again before upload, so a redirect onto
a blocked host is dropped: the browser still loads it, but nothing it read is
sent. Loopback, private-IP and local-network hosts are always blocked, whatever
the list says. Subresource loads are not intercepted.

The session event log persists every domain, title and scraped page body server-side
until deleted, and uploaded files persist independently. `runHomepageBuild` deletes
both in a `finally`. Confirm retention/ZDR eligibility against current docs before
distributing this.

The API key lives in `chrome.storage.local`, readable by anyone with access to the
browser profile. Fine for a tool you run yourself; **do not ship this to the Web Store**
without moving the key behind a proxy.
