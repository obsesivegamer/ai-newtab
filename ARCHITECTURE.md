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
`window.parent.postMessage({ type: "homepage:open-url", url: item.link, title: item.title }, "*")`
(the item's `link`, verbatim; `title` is optional, trimmed to 300 characters and shown as
plain text in the Reader until the article is fetched, else the host stands in). Both `homepage:open-article` and `homepage:open-url`
pass one gate in `App.tsx`: the message is a plain object with exactly that `type`;
its `source` is the `contentWindow` of an iframe inside `.today-frame`; the Today
tab is showing and no Reader is open (a hidden or covered frame cannot have been
clicked, and a page may not replace what you are reading); at most 3 requests per
second are looked at and an immediate repeat is dropped. Then, for open-url, `url`
must be a string of at most 2048 characters that parses as `http:` or `https:` with
no credentials and passes `isAllowedUrl` against the blocked-sites list (so
loopback, private hosts and Amber's own address are refused). The parsed `href` is
used from then on, with `%27` turned back into `'` (the model's links arrive with
the apostrophe percent-encoded). The page opens the in-page Reader on it and does
nothing else: it never navigates, opens a window, or saves. The Reader shows the
host as a title and a "Fetch full article" button; pressing that button (a user
gesture in the extension's own UI) is what saves the URL to Amber. Before that it
may only *look the address up* (`GET /api/lookup`), so a story already in Amber
reads at once. Stories the user already saved keep using `homepage:open-article`:
the `getFeeds` handler itself matches each item to the archive (by canonical link)
and attaches `archiveId` and `permalink`, and the prompt tells the model to use the
open-article message for items that have them and open-url for the rest.

**Latest and the Reader.** The new-tab page's default view, Latest, is deterministic
(no model, no API key). The page itself fetches the user's sources' feeds, all
sources in parallel, and shows each source's stories as it settles; one slow feed
(each has a 15 s limit) never holds the others back. The last fetch is stored in
`chrome.storage.local` (`latestFeed`, each source capped the way the stream caps
it, and not written at all over about 1.5 MB) and shared by every new tab: a tab
shows it at once and refetches by itself only when it is older than 5 minutes or
the set of sources changed. A source that failed counts as fetched: it is listed
with its own Retry, and one feed being down never makes every new tab refetch.
The refresh button and a source's Retry fetch on demand, and a Retry is written
back to the stored fetch. A source is not requested at all when its publisher is
on the blocked-sites list or its feed address is on a private, loopback or
local-network host (`isSourceBlocked`); if that leaves no source, Latest says so
and the stored fetch is cleared. Stories whose link host is on the blocked-sites
list are dropped on the page. Stories whose link matches an archived article's
`originalUrl` (`articleKey`: canonical link, `%27` as `'`) are marked "In Amber".

Saving rules, in one place: nothing is ever saved to Amber except as the direct result
of a person's gesture on a story.

- A click or Enter on a Latest row opens its Reader with permission to save
  (`ReaderEntry.autoFetch`). The Reader reads from the archive when the story is
  there; otherwise it shows the headline and summary and `lib/archive-save.ts` does
  lookup, then `POST /api/save`, then polls `/api/jobs/{id}` about every 2 s for up
  to about 90 s, then `/api/snapshots/{id}/text`.
- Anything reached afterwards with j/k, the arrows or the next card, and anything
  opened by the model-built page, only looks itself up and otherwise shows "Fetch
  full article"; pressing it is the gesture. That permission belongs to one
  attempt on one article: it ends when the attempt finishes (success or failure)
  and when another article is shown, so walking away and back never saves again.
  "Try again" and a forced recapture ("Try capturing again" on a paywall stub) are
  new clicks on the article they were pressed on. A look-up that finds a capture
  already queued or running just watches it (polling `/api/jobs/{id}` changes
  nothing in Amber) and shows the capturing state.
- Enter on a Latest or Library row opens the row that has focus; with nothing
  focused it opens the keyboard cursor's row.
- A found snapshot that is not `usable` is treated as not archived. Failures come
  back typed: `amber-down`, `no-api` (an Amber without the save API), `busy`,
  `invalid-url`, `capture-failed`, `paywall-stub`, `timeout`.
- **Capture with my browser** is a third button next to "Try capturing again" /
  "Try again" and "Open original" in the Reader's `paywall-stub` ("No article text
  came back"), `capture-failed` and archived-but-no-text failure states, and it is
  the retry after a failed browser attempt. It is a gesture like the others and
  one-shot: the click's attempt (`attemptRef.browser`) is spent the moment it
  starts, so a re-render, walking away and back, or j/k never runs it again, and
  it is never offered or run on navigation, prefetch or a message from the
  model-built page. It does not use the save API at all (see below).

**Capture with my browser** (`lib/browser-capture.ts`, `importFromBrowser`).
Amber's own capture is anonymous, so a subscriber's paywall hands it a stub. The
extension runs in the signed-in browser, so it loads the article there and gives
Amber the HTML:

1. A cheap read-only `GET /api/lookup` on the story first: if Amber is down or has
   no JSON API the Reader says so before any window opens.
2. `captureWithBrowser(url, { signal, onStatus })` refuses without opening anything
   unless `url` is http(s), has no credentials, is not on a loopback, private or
   local-network host and `isAllowedUrl` passes against the blocked-sites list
   (read from storage at that moment, not from a prop). It then opens a background
   window straight on the URL (`createScraperWindow(url)`, the same unfocused window
   `getPageHtml` uses) and mutes its tab. It waits for load (30 s; a page that is
   still "loading" at 30 s is used if `document.readyState` is `interactive` or
   `complete`), then 2 s of settle. **Before the page is scrolled or read** its
   address is checked again: it must pass `isAllowedUrl` and be the *same site* as
   the story asked for (`sameSite`, which mirrors Amber's rule exactly; Amber is the authority, see its
   README "Same-site rule for final_url": the same host or the same registrable
   domain, and the same port or both on a default port; scheme not compared; the
   registrable domain is the longest matching suffix from a fixed list of
   two-label public suffixes and shared-hosting suffixes plus one label, else the
   last two labels; IP literals match exactly). A redirect to a sign-in host or a shortener therefore ends
   the capture with "The page sent your browser to <host>. Sign in there first,
   then try again." and nothing is read or sent. The check runs again on the
   address the script read the page from. The page is scrolled with the same
   content script as the scraper (cut off after about 8 s in this mode, and never
   started twice after a timeout) and `document.documentElement.outerHTML` is read.
   That is the one place the scraper script is told (`__rawDocument`, set in its
   isolated world just before injection) not to sanitize: Amber's extractor needs
   the real markup, which `getPageHtml`'s cleaned copy for the model has lost. A
   page over 12 MB is refused, never truncated.
3. The window is closed in a `finally`, on abort (leaving the Reader mid-capture,
   including while the window is still being created) and when the new-tab page
   goes away. Closing the window or tab yourself ends the capture at once ("The
   page was closed.", via `tabs.onRemoved`). Neither URLs nor HTML are logged.
4. `importPage` (`lib/archive-save.ts`) sends `POST /api/import` as
   `application/json` `{ url, html, title?, final_url }` to the configured archive
   address, with a 60 s limit. `url` is the story's own address (so `/api/lookup`
   finds the new snapshot, which is now the newest for it); `final_url` is where the
   page actually ended up, which Amber resolves and validates like `url` (a public
   name can resolve to a private address, which a hostname check cannot see); a
   private one is a 400 and nothing is stored ("The page ended up on a private or
   local address"). `title` is the feed's headline when there is one. Lone UTF-16
   surrogates in the page are replaced with U+FFFD first (Amber rejects them), and
   the finished JSON body is measured: above 11.5 MiB it is refused before sending
   (Amber's own limit is 12 MiB). Failures are typed: `amber-down`, `no-api`
   (404/405), `too-big` (413 or the size check), `busy` (429), `invalid-url` (400,
   422), `forbidden` (403), `import-timeout` (the 60 s ran out: Amber may still
   finish, and a retry may save a second copy, which the notice says) and
   `amber-error` ("Amber answered 500", for any status not listed). A 400 `final_url is a different site` becomes the off-site message (naming the page's host), `final_url is a private or local address` becomes `private-address`, and a 408 is `upload-timeout` ("The upload to Amber took too long. Try again."). A 409 `{detail: "already archived", id}` (a usable copy of the story or of its final address exists; an import never replaces one, and `force` is never sent) is a success: that snapshot's text is read and shown and the story is marked, with no error. The same holds before any window opens: if the click-time lookup already finds a usable copy it is read instead of capturing.
5. A response with `usable: false` means Amber found no article in the page either:
   the reader says "Your browser also got a subscription prompt. Are you signed in
   to <host>?" with Open original (and the same button as a retry). Otherwise the
   text is read from `/api/snapshots/{id}/text` and the story becomes "In Amber"
   in Latest and Library through the same `onSaved` path a save uses. If that
   read-back fails the page *is* saved: the story is marked "In Amber", the notice
   says "Saved to Amber, but couldn't read it back", and its Try again only re-reads
   that snapshot (nothing is imported twice). Reopening a captured story later
   (even after a reload) reads that snapshot and imports nothing. There is no
   retry button for `no-api`, `too-big`, `blocked`, `private-address` or
   `saved-unreadable` (the last has its own Try again), since a second identical
   click cannot work.
6. A story that came from the model-built Today page (origin "today") shows the
   whole address (cut in the middle only above 120 characters) above the buttons
   in the failure notice, so you can see what "Capture with my browser" will open.

Residuals, known and accepted: if the extension is reloaded or the browser quits
while a capture is running, the background window it opened is left open (nothing
of ours is running to close it); it holds one article page and can simply be closed.
The imported HTML is the whole document, so it keeps page chrome that is not
article text (hidden form fields, meta tags, inline scripts); Amber is being changed
to strip hidden-input values and token metas, and only the *extracted article text*
(`/api/snapshots/{id}/text`) ever reaches the model or the Reader. The permission
set is unchanged: nothing is added for this (no `webRequest`); Amber's resolution of
`final_url` is the check on where the page really ended up.

**Sources that are not plain RSS.** Two publishers need care, both in the table in
`feed-catalog.ts`:

- *WSJ.* Dow Jones moved its feeds from `feeds.a.dj.com/rss/*.xml` (frozen at 2025)
  to `https://feeds.content.dowjones.io/public/rss/<Name>`; the default WSJ source
  reads World, US Business, Markets and WSJ.D. Its links carry `?mod=rss_*` /
  `?mod=pls_*`, which `link.ts` treats as tracking so one story in two feeds is one row.
- *Washington Post.* `feeds.washingtonpost.com/rss/<section>` answers 502 from nginx
  (confirmed 2026-10-20). The same sections are
  `https://www.washingtonpost.com/arcio/rss/category/<section>/` (national, world,
  business, politics). Akamai stalls non-browser clients on `www.washingtonpost.com`;
  Latest fetches from the browser, which is allowed through.
- *Reuters.* There is no public RSS. Its news sitemap
  (`https://www.reuters.com/arc/outboundfeeds/news-sitemap/?outputType=xml`, the 50
  newest stories) is read by `parseFeed` as a feed: `<news:title>`, `<loc>` and
  `<news:publication_date>` (else `<lastmod>`) per `<url>`, a section from the first
  `<news:keywords>` entry or the first path segment that is not a language code, no
  summary. Entries under a language edition (`/fr/`, `/pt/`, `/latam/`,
  `/fact-check/portugues/`, …) are left out when the sitemap is Reuters' (it labels every
  edition `en`) or when the entry's `news:language` is not the edition's own; a German
  publisher's `/de/` entries declaring `de` are read in full. Only entries with
  `<news:news>` count towards the 500-item cap.

`loadSources` (`lib/sources.ts`) hands back the stored catalog at once and migrates
it on the way: a source whose feeds are still exactly an earlier default (WSJ's
`feeds.a.dj.com` one, or the Washington Post's `feeds.washingtonpost.com` sections)
gets the current defaults on every load (free, synchronous);
Reuters is offered once, in the background, when the archive or history says the person
reads it and no source covers `reuters.com`. "Once" is `sourcesMigrated`, which
`saveSources` also sets (a list the person saved is theirs), and the list and flag
are read again after the archive answers so a save made meanwhile wins. The check is
held off for an hour (`sourcesMigrationTriedAt`) after each try, so a down or
mistyped archive never delays Latest or is retried on every load, and nothing is
written while the archive is unreachable and nothing else changed. Settings →
"Re-seed from my archive" merges the same table.

Settings: saving the Sources list or the archive address never starts a build. The
footer offers "Save & rebuild" only when the instructions or the blocked-sites list
changed; otherwise it is just "Save".

## Phone / web version

`apps/web` is the new-tab reader as a static site for a phone: Latest, Library, a
read-only Today and the Reader. Amber serves its build at `/app/`
(`AMBER_WEBAPP_DIR`) and the page is **same-origin with Amber's API**, so the
archive address is `location.origin` (there is no address setting) and nothing
needs CORS. The agent loop, the API key and the service worker do not exist in it.

It reuses the extension's code by import, not by copy: `apps/web/vite.config.ts`
aliases `@/` to `apps/extension` and imports `entrypoints/newtab/{components,
useLatest, useArchiveList, uiPrefs, readerEntry, format, articleText, styles.css}`
as they are. Only three seams differ:

| Seam | Extension | Web |
|---|---|---|
| `browser.*` | the real WebExtension API | `src/shims/browser.ts`: `storage.local` over `localStorage` (+ `onChanged`), an empty `history`, inert `runtime` |
| `@/lib/platform` (`IS_WEB`) | `false` | `true`: no "Capture with my browser", the Reader gets a bottom prev/next dock, a phone-size default text size |
| `@/lib/browser-capture` | tabs/scripting capture | a stub, so that code never reaches the bundle |

`apps/extension/lib/phone-sync.ts` is the shared client for the two things the
extension and the phone exchange through Amber (Amber only stores them; all of it
is best-effort and never blocks a build or a settings save):

| Endpoint | Written by | Read by | Shape |
|---|---|---|---|
| `PUT /api/homepage` | the worker, after each successful build, when the archive address is a shareable host (`pushHomepage`) | web Today (`GET`) | `{ code, timestamp }` (the raw TSX, as stored in `chrome.storage`) |
| `PUT /api/sources` | Settings → Sources → Save in the extension (or a change to the blocked-sites list), when the archive address is a shareable host; the web Settings on every edit, debounced 800 ms (`publishSources`) | web on load, when Settings opens and when the page is shown again; the extension when its Settings opens (`GET`; used when present, else seeded from the archive) | `{ sources: [{ id, name, feedUrls[], enabled }], if_updated_at? }`, answered with `{ count, updated_at }` |

**Who may receive them.** Both pushes go through one check in `phone-sync.ts`
(`isShareableArchiveHost`): the archive host must be loopback (`localhost`,
`127.0.0.0/8`, `[::1]`), private IPv4 (`10/8`, `172.16/12`, `192.168/16`),
Tailscale's CGNAT range (`100.64.0.0/10`) or a `*.ts.net` / `*.local` name. Otherwise
nothing is sent (a console warning names the host). Reading is not limited, and the web
app, which only ever talks to the Amber that served it, is exempt (`IS_WEB`).
The extension also drops every source that `isSourceBlocked` reports against its own
current blocked list before publishing, so the phone never receives a blocked publisher.

**Source sync is optimistic.** Amber's list carries `updated_at` (one-second
resolution). Each device keeps the stamp it last saw (`KEYS.sourcesSyncStamp`: chrome
storage in the extension, `localStorage` through the shim on the phone) and sends it as
`if_updated_at`; Amber writes only if its stamp is that value and otherwise answers
`409 { detail, updated_at, sources }` without writing. `publishSources` then adopts the
returned list and stamp into storage, reports `conflict`, and does not retry. A first
push (no stamp) is unconditional, and so is a PUT without the field (last write wins).
Everything is best-effort: a failed read or write is silent and never clears a list.

- Phone (`src/sync.ts`): the boot read adopts Amber's list and stamp (a failed read
  leaves the local list alone); `refreshRemoteSources` re-reads when Settings opens and
  when the page becomes visible again, unless a feed probe is running or an edit is
  pending; a conflict or refresh that changes the list announces it, and `WebApp` shows
  the shared `SyncNote` ("Updated from another device") and reloads Latest. A pending
  debounced edit is flushed on `pagehide` and when the page becomes hidden, with
  `fetch(..., { keepalive: true })`. Pushes otherwise run one at a time so a second never
  carries a stamp the first is about to replace.
- Extension (`SettingsModal`): when it opens it reads `/api/sources`; if Amber's stamp
  differs from the stored one and the draft is untouched, the list goes into the draft
  with "Updated from your phone" (Save keeps it, Cancel drops it). Save sends the stamp
  it adopted, or the stored one; a 409 stores Amber's list and stamp and `App` shows
  the same `SyncNote` ("Updated from your phone").

Other web-specific behaviour:

- **Feeds go through `GET /api/feedproxy?url=`.** `src/feedProxy.ts` wraps
  `window.fetch` once: a GET to another origin is rerouted to the proxy, same-origin
  calls pass through, and the response is given the publisher's address as its `url`
  so agent-core's private-redirect check still reads the right host. agent-core's feed
  code is unchanged and keeps calling `fetch`; the Settings feed probe goes through the
  same wrapper.
- **Today (`TodayStatic`)** fetches `/api/homepage`, transpiles it with `toRenderable`
  and renders it in the same sandboxed Sandpack frame (`HomepagePreview`), with
  "Built <time> on your Mac". Open requests from that frame use the *same gate* as the
  extension: both apps call `entrypoints/newtab/useHomepageOpen.ts` (exact message
  `type`, `source` is an iframe inside `.today-frame`, Today showing, no Reader or
  Settings open, 3 per second, 2 s repeat window, URL validation + `isAllowedUrl`;
  it only ever opens the Reader and never navigates or saves).
- **Saving rules are unchanged**: a tap on a Latest row is the gesture (`POST
  /api/save`, same-origin JSON); prev/next, the dock, and anything from Today only
  look up. Reader's "Open original" is `target=_blank`.
- **Amber's CSP for `/app/`** allows `script-src 'self'`, `connect-src 'self'` and
  `frame-src https://*.codesandbox.io` (Sandpack's bundler frame), so Today needs the
  phone to reach codesandbox.io.
- **Security model:** no login; the tailnet is the boundary. Expose with
  `tailscale serve`, never Funnel. See the README's "On your phone" section.

## Layout

```
packages/agent-core/      host-agnostic agent loop — imports no chrome.*, browser.*, or node:*
  orchestrator.ts         runHomepageBuild: session lifecycle, event loop, tool dispatch, cleanup
  setup.ts                ensureAgent / ensureEnvironment (created once, cached by ID)
  prompt.ts               system prompt + per-build kickoff message
  schemas.ts              custom tool input schemas (getFeeds, getArchive, getArchiveArticles, getHistory, getPageHtml) and defaults
  history-digest.ts       narrows raw history to fit a tool result
  abort.ts                anySignal: AbortSignal.any with a fallback for Safari < 17.4 (iPhone), used wherever a timeout is combined with a caller's signal
  archive-url.ts          normalizeArchiveUrl / archiveHostOf: archive address cleanup shared by the extension and harness
  link.ts                 canonicalLink / safeLink / linkKey: link normalization shared by the handlers and the feed parser
  feeds.ts                parseFeed (RSS, Atom, RDF and Google News sitemaps), fetchSourceFeeds, mergeSourceFetches, createFeedBridge,
                          probeFeed: fetch + AbortSignal only, hardened against hostile feeds (body cap, element text caps,
                          linear-time scanning, private-address checks)
  feed-catalog.ts         the table of publications we know feeds for, seeding, retired-feed migration, and the pure source-list edits
  types.ts                BrowserBridge, ArchiveBridge, FeedBridge, KVStore, RunPhase, …

apps/extension/           MV3 extension (WXT + React)
  entrypoints/
    background.ts         service worker: hosts BuildManager, alarm heartbeat
    scraper.content.ts    injected into scraped tabs: scroll, return HTML (raw outerHTML when browser-capture asks)
    newtab/               the new-tab UI (thin client onto the worker)
      components/Latest.tsx   the live stream: chips, search, per-source retry, "In Amber" marker
      useLatest.ts            progressive fetch, the shared stored fetch, blocked-site filter, archive index
      components/Reader.tsx   reads an archived story or a story from outside the archive
      readerEntry.ts          what the Reader opens: an archive id or an external story
  lib/
    build-manager.ts      single-flight build host, broadcast, keepalive, reattach
    browser-bridge.ts     BrowserBridge over chrome.history / chrome.tabs
    archive.ts            ArchiveBridge over fetch to Amber's JSON API; shared by the worker and the new-tab page
    archive-save.ts       lookup / save / poll / read / import against Amber's save and import APIs: the Reader's "fetch the full article" and its import half of "Capture with my browser"
    feeds.ts              re-exports agent-core's feed code for the extension
    sources.ts            the stored catalog of sources (chrome.storage), seeding from the archive and history
    history.ts            getHistory: group and rank chrome.history by domain
    scraper.ts            getPageHtml: load URLs in a background window, sanitize HTML
    browser-capture.ts    "Capture with my browser": load one URL in the signed-in browser, import the raw HTML into Amber
    protocol.ts           page ↔ worker messages and the five UI build steps
    auto-rebuild.ts       when to rebuild on a schedule
    storage.ts            chrome.storage keys, settings (incl. archiveUrl), saved homepage
    phone-sync.ts         PUT/GET /api/homepage and /api/sources (stamp + 409 handling, shareable-host check): what the extension and the phone share through Amber
    platform.ts           IS_WEB = false (apps/web aliases it to true)
    transpile.ts          TSX → JS for the preview

apps/web/                 the phone/web version: Vite + React, imports the extension's new-tab UI (see "Phone / web version")
  src/shims/browser.ts    `browser.storage.local` over localStorage, empty history
  src/feedProxy.ts        cross-origin GETs -> /api/feedproxy
  src/WebApp.tsx          Latest / Library / Today / Reader shell, bottom tab bar
  src/TodayStatic.tsx     GET /api/homepage -> Sandpack
  src/WebSettings.tsx     theme + sources only
  src/web.css             phone layout, scoped to html.web

harness/                  Bun scripts: drive agent-core with a fixture/fetch bridge (an Amber
                          ArchiveBridge reading AMBER_URL, a FeedBridge reading FEEDS or the known
                          table), test the extension
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
| `getFeeds` | Input `sinceHours` (1-72, default 24) and `perSource` (1-15, default 8). Returns `{ fetchedAt, sources: [{ name, count, error? }], items: [{ id, title, link, source, publishedAt?, summary?, author?, section?, archiveId?, permalink? }] }`, newest first, at most 60 items, at most `perSource` per publication. Headline and blurb only, never article text. `archiveId` and `permalink` are set only when the user has saved that article. |

What the handler does on top of the bridge:

- **Blocklist on the link.** Each item's `link` goes through `isAllowedUrl`, so a
  blocked host, a private or local-network host and any non-HTTP(S) link are
  dropped. The model is never told blocked material existed (same rule as history
  and archive): `sources[].count` is recomputed from the items actually returned,
  after every cap; a publication with no items and no feed error is not listed,
  nor is one whose items were all blocked or whose name is itself a blocked host,
  and same-named sources are merged.
- **Normalized links.** `link` is the parsed `href` of the URL with `'`, `"`,
  backticks and whitespace percent-encoded (`safeLink` in `link.ts`), and links over
  2000 characters are dropped. The archive's `originalUrl` and `permalink` get the
  same treatment, in `getArchive` and `getArchiveArticles`.
- **Untrusted text.** Titles, summaries, authors, sections, ids and links come from
  the open web. Every text field is collapsed to one line and capped (title 300,
  summary 400, author 120, section 80, source 80); `id` must look like a hex hash or
  is regenerated from the link; `publishedAt` is kept only when it starts with an ISO
  date and is not more than 5 minutes in the future. Fields are rebuilt one by one,
  so nothing extra from the bridge reaches the model. The prompt tells the model to
  treat all of it as data.
- **Archive matching in code.** When an archive bridge exists, the first `getFeeds`
  of a build lists the last 365 days of the archive (up to 200 articles) once and
  caches it. An item whose `canonicalLink(link)` equals an archived article's
  canonical `originalUrl` gets `archiveId` and `permalink`. `canonicalLink` (`link.ts`,
  re-exported by the extension's `lib/feeds.ts`) drops the scheme, `www.`, the
  fragment, a trailing slash and tracking parameters, and sorts the rest of the
  query. If the archive can't be read, items just have no `archiveId`; `getFeeds`
  still succeeds.
- **Allow-list for `getPageHtml`.** Feed links are *not* added to the host
  allow-list. The run keeps `seenFeedLinks`, a set of exact normalized links
  (`href` with the fragment cleared); `getPageHtml` accepts a URL if it is exactly
  one of those links or its host passes the existing history-digest /
  archive-`originalUrl` check. A feed that names a page on some site therefore
  opens that page only, not the whole site in the user's logged-in browser. It still
  counts against the live-page cap, and is checked again after redirects.
- **Recorded after delivery.** Hosts and feed links are remembered only once the
  result was sent successfully, so a result the model never received grants nothing.
- **Reattach.** `restoreFromHistory` reads the `link` of every `items[]` entry back
  out of each answered, non-error `getFeeds` result into `seenFeedLinks`, so the
  allow-list survives a kill like the archive's and history's do. The log line
  `restored: N hosts, M archive refs, K feed items` reports what came back.
- **Errors.** Like every tool, `getFeeds` always sends one result: a missing bridge or
  a bridge that throws becomes an `is_error` result starting "The live feeds are
  unavailable". One feed failing is not an error: it shows up in `sources[].error`.

The build phase reuses `history` (`feeds <n>h` as the detail), like `getArchive`.

## The article archive (Amber)

Amber is a separate local app that saves readable copies of articles. This fork's
agent leads with it. The host supplies an `ArchiveBridge` (`types.ts`), passed to
`runHomepageBuild` as `archive`; the extension builds it in `lib/archive.ts` from
the `archiveUrl` setting (default `http://127.0.0.1:8080`, empty disables it).
Reads try that Mac first, then the offline reader at `fallbackArchiveUrl`
(default `http://dell-plx:8081`, empty turns failover off). A stored
`http://boxj:8081` is migrated to the current default; any other saved address
stays. The harness builds an equivalent Mac bridge from `AMBER_URL`. Without a bridge the
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
mounted, which hosts and feed links the model was shown) is not persisted. On a reattach the
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
| `pnpm agent:run` | Full build against the real API: tools, mounting, sandbox grep/read, deliverable, cleanup. Uses Amber at `AMBER_URL` when it is reachable, and live feeds from `FEEDS` (comma-separated feed addresses) or the known publications table |
| `pnpm agent:verify` | The deliverable transforms, evaluates and server-renders |
| `pnpm agent:resume-test` | A build killed with a tool call pending can be reattached and finished |
| `pnpm agent:retention <sessionId>` | The session and every uploaded page body are actually deleted |
| `pnpm extension:test` | In headless Chrome: worker registers, new tab renders, port protocol answers, `chrome.history` reads |
| `.claude/skills/verify-newtab/scripts/verify-web.py` | The phone version in an iPhone-14 emulation against a throwaway Amber on a data copy: feeds only via the proxy, tap-to-save, Reader prev/next, Settings sync (stamp, 409 adoption, pagehide flush, re-read on show, unreadable boot read), Today from a published page and after a failed refresh, the open-article gate, no `AbortSignal.any`, no overflow at 375/390/430 |

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
publishers (no cookies), a source whose publisher is blocked, or whose feed
address is on a private or local-network host, is not requested (builds and
Latest alike), and nothing is saved to the archive except on an explicit click in
the Reader. What the
model sees of the archive is the listing (titles, authors, publisher URLs, save
dates and per-publication counts for up to 40 articles per `getArchive` call) and
the full text of the articles it asks for; the text is sent to the API in the same
way as scraped pages and deleted with the rest of the session's uploads.
Each scraped page's final URL is checked again before upload, so a redirect onto
a blocked host is dropped: the browser still loads it, but nothing it read is
sent. Loopback, private-IP and local-network hosts are always blocked, whatever
the list says. Subresource loads are not intercepted.

**Capture with my browser** moves a page differently: it goes from your browser to
the Amber address you configured (`POST /api/import`; any http(s) address you set,
and it is plain http unless you put https, which for the default `127.0.0.1` never
leaves the machine) and nowhere else. Nothing reaches Anthropic unless you later
build Today and the model chooses to read that article from the archive (then it
is an ordinary archived article: its extracted text, capped and deleted with the
session like any other). It only ever starts from a click in the Reader, never from
navigation, prefetch or the model-built page. The blocked-sites list and the
loopback/private-host rule apply before the browser opens anything, again to the
page's address before it is read (which must also be the same site), and Amber
validates the final address too. The HTML is the full document as your signed-in
browser rendered it, so it may contain personal account details (your name, email,
subscriber id, tokens in inline scripts or hidden fields). It is stored as a
snapshot in your local archive and stays there; treat the archive, and screenshots
of it, as private.

**The phone version** (`apps/web`) has no login: it is protected only by being
reachable on your tailnet. It can read your archive and save to it, and what the
extension publishes to Amber (`homepage.json`, with titles and blurbs from your
reading, and `sources.json`) is stored in Amber's data directory and served to
anyone who can reach it. Nothing in it reaches Anthropic: there is no key, build or
model there. Never expose it with `tailscale funnel`. The published Today page is
model-written code and runs only in the sandboxed Sandpack frame, under the same
open-request gate as in the extension. The extension publishes to Amber only when the
archive address is loopback, a private or Tailscale address, or a `*.ts.net` / `*.local`
name (see "Who may receive them" above), and leaves out sources on its blocked list.

The session event log persists every domain, title and scraped page body server-side
until deleted, and uploaded files persist independently. `runHomepageBuild` deletes
both in a `finally`. Confirm retention/ZDR eligibility against current docs before
distributing this.

The API key lives in `chrome.storage.local`, readable by anyone with access to the
browser profile. Fine for a tool you run yourself; **do not ship this to the Web Store**
without moving the key behind a proxy.
