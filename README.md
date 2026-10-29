# AI Homepage

**A new tab that reads the internet for you.**

AI Homepage replaces Chrome's new-tab page with one that's written for you. An
agent looks at what you've actually been browsing, opens the pages you follow
(signed in as you), and writes a fresh homepage from what it finds there. It
rebuilds itself in the background, so each new tab is up to date.

![An example homepage in a morning-newspaper style](docs/preview.png)
<sub>Illustration. Your homepage is built from your own browsing, so its stories will be different.</sub>

A morning newspaper is just one look. You can describe any look and the next build
follows it: a quiet one-column digest, a dense dashboard, a green-on-black
terminal, a zine.

## This fork: your article archive, then your browsing

This fork builds the homepage from the news you have already saved, plus what you
are browsing right now. The saved articles come
from [Amber](https://github.com/obsesivegamer/amber-archive), a local archiver that keeps a
readable, paywall-free copy of each article on your Mac.

- **The archive leads.** The agent lists your recent archived articles, picks the
  stories worth reading, groups them across publications, and links each one to
  its Amber permalink. Live browsing history is a supplement, not the base.
- **A Library and a reader that need no model.** The new tab can list the archive
  directly and show the full article text from Amber in a reader pane, with no
  API key and no credits.
- **Latest: what is new, from the sites you read.** The default tab lists the
  newest stories from your sources, merged newest first, with source filters and
  search. It needs no API key and no model. **Every new tab fetches your sources'
  public RSS/Atom feeds directly from your browser** (no cookies, nothing goes
  through a server of ours). A new tab shows the last fetch at once, which is kept
  and shared by every tab, and fetches again by itself only when it is more than
  five minutes old (or the sources changed). A source that failed does not make
  every new tab refetch: it has its own Retry. The refresh button fetches on
  demand. Nothing is requested from a source on your blocked list, and stories
  from a blocked site are not shown.
- **Sources.** **Settings → Sources** lists the publications Latest and Today read.
  It is seeded from the sites in your archive (and your browsing history) for
  publications we know feeds for; you can switch sources off and add any feed
  address (or a page that links to one). WSJ is read from Dow Jones' current feed
  host (the old `feeds.a.dj.com` feeds stopped updating in 2025). The Washington
  Post is read from its Arc section feeds (`www.washingtonpost.com/arcio/rss/category/…`);
  the old `feeds.washingtonpost.com` sections answer 502. Reuters has no
  RSS, so its public news sitemap (the 50 newest stories) is read as a feed.
- **Full text on demand.** Open a story that is not in your archive and the reader
  asks Amber to save it, waits for the capture, and shows the full text. This
  needs a version of Amber with the save API (`/api/lookup`, `/api/save`:
  [Amber PR #17](https://github.com/obsesivegamer/amber-archive/pull/17)). Nothing is
  saved unless you open that story with a click or Enter, or press **Fetch full
  article** yourself; moving through the list with j/k only looks.
- **Capture with my browser.** Some publishers (WSJ, FT, NYT) show Amber's own
  capture only a subscription prompt, so the reader says "No article text came
  back". Press **Capture with my browser** and the extension opens that page in a
  muted background window of your own, signed-in Chrome, then hands the page's HTML
  to Amber (`POST /api/import`), which makes it the newest copy of that story. This
  needs an Amber with the import API; an older one says "Update Amber to use
  this". If your browser got a subscription prompt too, it says so and asks
  whether you are signed in; if the page sends your browser to another site (a
  sign-in host), it stops there and tells you which. The page goes only to the
  Amber address you configured (any http(s) address you set; plain http if it is
  not local, so keep it on your own machine) and never to Anthropic, unless you
  later build Today and the model reads that article. It only happens when you
  press the button, and never for a site on your blocked-sites list or a private
  address. The saved HTML may contain your account details (name, email,
  subscriber ids, hidden form fields); it is stored in your local archive, so treat
  the archive as private. If the extension is reloaded mid-capture, the background
  window can be left open; just close it.
- **Amber has to be running.** The extension talks to Amber's local JSON API at
  `http://127.0.0.1:8080` (change it in **Settings → Article archive (Amber)**;
  leave it empty to turn the archive off). If Amber is stopped, the Library says
  so and builds fall back to browsing history only.
- **Permalinks only work while Amber runs on this Mac.**

Start Amber the way its own README describes: its run script from `<your Amber
checkout>`, or its launchd service if you installed one.

Amber needs the version that has the JSON API (`GET /api/snapshots`). After
updating Amber, restart it. In Settings, **Test connection** tells you how many
readable articles it can see.

> **Privacy, up front.** To build your homepage, the extension sends a summary of
> your browsing history (top domains, visit counts, a few page titles) and the
> cleaned-up HTML of up to 8 pages to the Anthropic API, using your own API key.
> Those pages are loaded in your signed-in browser, so they can include private
> content. With the archive on, the archive listing goes to the same API too:
> titles, authors, publisher URLs and save dates for up to 40 articles per
> `getArchive` call, plus per-publication counts. So does the text of archived
> articles: at most 24 per build, each cut to about 2,000 words. The agent session
> and every uploaded page and article are deleted when each build ends. Your API
> key stays in the extension's local storage. More detail in
> [ARCHITECTURE.md](./ARCHITECTURE.md#privacy).
>
> **Capture with my browser** (a button you press yourself) sends a page you are
> signed in to from your browser to the Amber address you configured and nowhere
> else.

---

## Install

You need Chrome (or another Chromium browser), [Node.js](https://nodejs.org) 20+,
and an [Anthropic API key](https://console.anthropic.com).

```bash
git clone https://github.com/ThariqS/ai-newtab.git
cd ai-newtab
npx pnpm@10.11.1 install
npx pnpm@10.11.1 build
```

(If you already have [pnpm](https://pnpm.io), plain `pnpm install && pnpm build` works too.)

Then load it into Chrome:

1. Go to `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose `apps/extension/.output/chrome-mv3`.

If Chrome asks whether to keep the changed new-tab page, choose **Keep it**.

## Your first homepage

1. Open a new tab, switch to the **Today** tab, and paste your Anthropic API key.
2. Click **Build today's homepage**.
3. Watch it work. The progress view walks through each step: preparing the
   agent, reading your archive and history, opening articles and pages,
   analyzing them, and writing your homepage.

The first build takes a few minutes. You can close the tab while it runs, since
the build lives in the extension's background worker and appears in any new tab
you open.

## Make it yours

Click **⚙️ Settings** on the new tab.

**Instructions.** Anything you write here goes into every build and takes priority
over the agent's own defaults. This box sets both the content and the look:

| You write | You get |
| --- | --- |
| *"A morning newspaper. Serif type, a big masthead, a lead story, a column of briefs."* | A broadsheet front page |
| *"One calm column. No images. Five things worth reading, with one line on why."* | A quiet reading list |
| *"Dense dashboard: GitHub PRs and issues first, then Hacker News, then everything else."* | A work cockpit |
| *"Green-on-black terminal, monospace, like a 1980s BBS."* | Exactly that |
| *"Skip sports and politics. Always show the weather and my next three calendar events."* | Your rules, every day |

Click **Save & rebuild** to apply them right away. (The button appears when the instructions or the blocked-sites list changed; saving sources or the archive address never starts a build.)

**Sites the agent never reads.** Enter one host per line; subdomains are included,
and `*.example.com` is supported. The editable defaults include common webmail,
sign-in and document hosts. **Save & rebuild** saves the list and applies it to
history summaries and URLs requested through `getPageHtml`. A page that redirects
onto a blocked host is dropped before its content is uploaded. Local-network
addresses (localhost, private IPs, `.local` and `.internal` hosts) are always blocked.

**Sources.** The publications Latest and Today read. Switch a source off, add a feed address (it is checked first: it must be a feed, or a page that links to one), or re-seed from your archive. Changes are saved with **Save**.

**Article archive (Amber).** The address of your Amber server, default
`http://127.0.0.1:8080`. **Test connection** reads Amber's article list and tells
you how many readable articles it found, or that Amber isn't running. The address
is saved when the test succeeds or when you click **Save & rebuild**; Cancel
discards edits. A missing `http://` is added for you. Leave the
box empty to build from browsing history only. The blocked-sites list above also
applies to archived articles, matched on the publisher's address.

**Offline reader.** When the Mac archive doesn't answer, saved articles are read
from here instead. The default is `http://dell-plx:8081`. Leave it empty to turn
that off. Its password is sent only to that address, as HTTP Basic for the user
`amber`. A stored `http://boxj:8081` (the previous default) is rewritten to the
current default; any other address is left as you saved it.

**Model.** Choose which Claude model writes your page:

- **Claude Sonnet 5.5** (default): the best balance of quality and cost.
- **Claude Haiku 5.5**: the fastest and cheapest.
- **Claude Opus 5.5**: the most careful editor, and the most expensive.

The new model takes effect from your next build.

**Rebuild automatically.** On by default. Once your homepage is older than the
interval you pick (6, 12, 24 or 48 hours), the extension rebuilds it quietly in the
background. It only starts after you've built once by hand, and it won't retry a
failed build until the next interval, so it never loops.

**↻ Rebuild** in the top-right corner rebuilds right away.

## Good to know

- **Cost.** Each build is a single agent session billed to your API key. What it
  costs depends on the model and on how much it reads. Haiku is the cheapest
  choice, and you can turn off automatic rebuilds to build only when you ask.
- **What it can see.** With the archive on, it is asked to read about a dozen of
  your recent archived articles and to look at a few live pages (about 4); without
  it, up to 8 live pages. Those numbers are requests in the prompt, not limits. The
  hard limit for archived articles is 24 per build, with each one cut to about
  2,000 words for the model. The reader in the new tab always shows the full text.
  It skips search engines, webmail, banking and logged-out marketing pages. Anything it can't open is reported, not hidden.
- **Links are real.** Every link on the page comes from a page the agent actually
  read. It's told never to invent a URL.
- **Interrupted builds.** If Chrome closes mid-build, the new tab offers
  **Resume interrupted build** next time.
- **Updating.** After pulling new code, run `npx pnpm@10.11.1 build` again, then
  click the reload icon on the extension in `chrome://extensions`.

## How it works

0. **`getFeeds`**: what is new from your sources: headlines and blurbs from their
   public feeds, matched to the archive by link.
1. **`getArchive`**: the agent gets the list of your recent Amber articles
   (titles, publication, date, word count, permalink) and per-publication counts.
2. **`getArchiveArticles`**: it picks a handful (up to 12 per call, 24 per build),
   and the extension fetches their text from Amber and mounts each into the
   agent's sandbox as a text file, cut to about 2,000 words.
3. **`getHistory`**: a ranked summary of your most-visited domains.
4. **`getPageHtml`**: a few live pages (the prompt asks for about 4 with the
   archive, the tool allows up to 8), which the extension opens in a background
   window, cleans up, and mounts as files.
5. **`grep` / `read`**: the agent pulls headlines, quotes and links out of those
   files inside its sandbox.
6. **`write`**: it writes one React component, which the new tab renders.

The extension's background worker drives a
[Claude Managed Agents](https://docs.claude.com) session directly, with no server
in between. The custom tools run in the extension because they need
`chrome.history`, `chrome.tabs` and the local Amber server. Everything else happens in the agent's
sandbox, where shell access is off: scraped pages are untrusted input.

See **[ARCHITECTURE.md](./ARCHITECTURE.md)** for the event flow, the layout, and
the gotchas worth knowing.

## On your phone (web version)

The same Latest, Library, Today and Reader, in the same dark reading design, as a
web page for your iPhone. Amber serves it at `/app/` and you reach it over
Tailscale. It is the extension's own UI code built as a static site
(`apps/web`), not a copy.

```bash
pnpm install
pnpm web:build            # -> apps/web/dist (base path /app/)

# In Amber's checkout: serve it and answer to your tailnet name, then expose it.
AMBER_WEBAPP_DIR=/path/to/ai-newtab/apps/web/dist \
AMBER_ALLOWED_HOSTS=<mac>.<tailnet>.ts.net ./run.sh
tailscale serve --bg --https=443 http://127.0.0.1:8080
```

Open `https://<mac>.<tailnet>.ts.net/app/` in Safari and use **Share → Add to Home
Screen** for a full-screen app. This needs an Amber that has the web-app routes
(`/app/`, `/api/feedproxy`, `/api/homepage`, `/api/sources`).

- **Latest and Library work on their own.** The page reads your sources' feeds
  through Amber (`/api/feedproxy`), so it needs nothing else.
- **Today is built on your Mac.** After each successful build the extension
  hands the page to Amber (`PUT /api/homepage`), and the phone shows it with the
  time it was built. Until you have built one, the phone says "No Today page
  yet." There is no API key, build or model on the phone. If a later refresh
  can't reach Amber, the phone keeps the last copy and says "Couldn't refresh —
  showing the last copy".
- **Sources are shared.** Saving **Settings → Sources** in the extension also
  sends the list to Amber (`PUT /api/sources`); the phone adopts it on load, and
  edits made on the phone are sent back (also when you close the page or switch
  away, so a toggle is not lost). Without a stored list the phone seeds
  from your archive like the extension does. Each device sends the version
  stamp it last saw with its edit, so one device can't silently overwrite the
  other's newer list: the phone re-reads Amber's list when Settings opens and
  when you come back to the page, and a refused write is replaced by Amber's
  list with a short "Updated from another device" note; the extension does
  the same when its Settings opens ("Updated from your phone", still yours to
  Save or Cancel). A source whose publisher is on your Mac's blocked-sites list
  is left out of what the phone receives.
- **Tapping a story saves it** exactly as on the Mac (a tap, never a swipe or
  prev/next), through Amber's `POST /api/save`.
- **Only to your own network.** The extension publishes Today and the
  sources only when the archive address (Settings → Article archive) is this
  computer (`localhost`, `127.0.0.0/8`, `[::1]`), a private IPv4 address
  (`10/8`, `172.16/12`, `192.168/16`), a Tailscale address (`100.64.0.0/10`),
  or a name ending in `.ts.net` or `.local`. Any other address (a public host,
  or a bare name like `http://mac`) is never sent them. Use the `.ts.net` name
  or the IP address of your Mac.
- **Not on the phone:** *Capture with my browser* (it needs your Mac's signed-in
  browser), building Today, browsing history, and editing the blocked-sites list
  (the phone uses the default list).

**Security model.** There is no login. Whoever can reach the address can read your
archive and save to it, so keep it on your tailnet: use `tailscale serve`, never
`tailscale funnel` (which publishes to the open internet), and use Tailscale ACLs
if other people are on your tailnet. Amber still listens only on `127.0.0.1`;
`tailscale serve` is what makes it reachable, over HTTPS, to your own devices.
The Today page you publish (`homepage.json`) and your sources (`sources.json`)
are stored in Amber's data directory and contain your reading, so treat them like
the archive.

## Development

```
packages/agent-core   the agent loop: host-agnostic, no chrome.* or node:*
apps/extension        the MV3 extension (WXT + React)
apps/web              the phone/web version (Vite + React): imports the extension's new-tab UI, served by Amber at /app/
harness               Bun scripts that run agent-core outside Chrome, and test the built extension
```

```bash
pnpm dev                 # WXT with hot reload
pnpm web:build           # the phone/web version -> apps/web/dist
pnpm typecheck           # all packages
pnpm test                # unit tests (no API calls; needs Bun)
pnpm extension:test      # loads the built extension into headless Chrome (no API calls)

cp .env.example .env     # add ANTHROPIC_API_KEY, then:
pnpm agent:run           # a full build against the real API, with fixture history, your Amber archive and live feeds
                         # (AMBER_URL overrides the address; AMBER_URL= runs without the archive;
                         #  FEEDS=https://a/rss,https://b/rss picks the feeds; FEEDS= turns them off)
pnpm agent:verify        # check the output actually renders
```

## Status

Early and experimental. It's a tool you run yourself with your own key. Don't
publish it to a store as-is: anyone with access to the browser profile can read
the stored API key.

## License

MIT
