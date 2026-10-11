---
name: verify-newtab
description: Visually verify the AI new-tab extension (Latest, Library, Reader, Settings, Today, Amber-down) in headless Chrome against a throwaway Amber running on a COPY of the data, in dark and light. Use after any change to apps/extension/entrypoints/newtab (components, styles.css, App.tsx), apps/extension/lib/archive.ts, or anything else that changes what the new-tab page looks like or how it talks to Amber.
---

# verify-newtab

One command builds nothing by default, copies Amber's data to a temp dir, starts a throwaway Amber on the copy, loads the built extension into headless Chrome, drives the real UI, saves screenshots, and prints DOM assertions. Nothing is written into the repo.

## Run it

From the repo root:

```bash
# 1. Build first if you changed source (or pass --build to the script)
npx -y pnpm@10.11.1 build

# 2. Capture + assert
npx -y bun .claude/skills/verify-newtab/scripts/verify.ts
```

Options (all optional):

| Flag | Default | Meaning |
| --- | --- | --- |
| `--out <dir>` | fresh dir under the OS temp dir | where the PNGs and `amber.log` go |
| `--amber-dir <path>` | `~/Documents/amber-archive` | Amber checkout to run (needs the JSON API, `/api/lookup` + `/api/save` for the save flow (Amber PR #17), and `POST /api/import` for the "Capture with my browser" flow; without the import API that flow is skipped with a warning) |
| `--python <path>` | `<amber-dir>/.venv/bin/python` | interpreter with Amber's dependencies and Chromium (a fresh worktree has no `.venv`) |
| `--data-from <dir>` | `<amber-dir>/data` | the data dir to COPY; the copy is what Amber runs on and is deleted on exit |
| `--no-save` | off | skip the Latest -> Reader save/capture flow (it does a real capture of a live Guardian/Ars/BBC story) |
| `--probe-paywall` | off | also open an un-archived NYT/FT/WSJ story and report what the capture returns |
| `--port <n>` | `8090` | port for the throwaway Amber; `8080` is refused. Pick another if something already answers |
| `--build` | off | run `npx -y pnpm@10.11.1 build` first |
| `--chrome-port <n>` | random free port | Chrome DevTools port |

`CHROME_PATH` overrides the Chrome binary (default is the macOS Google Chrome path). The script warns when the build is older than the source, so a stale build does not pass for your change. It takes about 15 seconds and exits 0 only when no hard assertion failed.

What it does: copies `--data-from` to a temp dir, starts `python -m uvicorn app.main:app` on `--port` with `AMBER_DATA_DIR` set to the copy (so the save flow never writes to the real data), blocks `:8080` in the page before `archiveUrl` is set, sets `archiveUrl` in the fresh profile's `chrome.storage.local`, then captures 1280x900 at 2x for each of the following in **dark and light**. Amber and Chrome are always killed on exit, on error, and on SIGINT/SIGTERM. It never touches port 8080 or Amber's launchd service.

The "Capture with my browser" flow (dark and light) uses three more fixture stories served from the same fixture server but under `example.org`, a public name Amber can resolve (it validates an import's address with DNS) that only this Chrome maps to the fixture. The server answers a subscription stub unless the request carries the cookie `member=1`, which the script sets in the Chrome profile; `/members/locked` is a stub even for a member. Amber cannot reach the fixture host, so the script seeds Amber with the stub through `POST /api/import` (exactly what its crawler would have produced), then drives the Reader: stub notice with three buttons -> click -> page opened in a background window of the profile with its cookie -> raw HTML imported -> text -> "In Amber" without reload -> after a reload it reads from Amber with no import. Run it against an Amber with the import API, a COPY of the data and a spare port, for example:

```bash
npx -y bun .claude/skills/verify-newtab/scripts/verify.ts --no-save --port 8098 \
  --amber-dir ~/Documents/amber-archive-import-api \
  --python ~/Documents/amber-archive/.venv/bin/python \
  --data-from ~/Documents/amber-archive/data
```

The only POST from the page to Amber (besides the import) is the Latest save flow (`/api/save` on the throwaway Amber, one live story), and it lands in the copy. A local fixture feed (a small Bun server) supplies two stories Amber already has, one it does not, one it cannot capture (an unresolvable host: Amber answers 400) and one dated in the future. Chrome is started with `--host-resolver-rules` so the fixture is served as `verify-fixture.example`: feed addresses on loopback are refused by design, so a `127.0.0.1` fixture would never be fetched. A second fixture feed ("Verify flaky") answers 503 until the script flips it, and a `127.0.0.1` feed is used to prove private addresses are not requested.

## Screenshots

| File | Shows |
| --- | --- |
| `08-latest-<theme>.png` | Latest as seeded from the archive's sources, live feeds |
| `09-latest-source-chip-<theme>.png` | Latest filtered to the fixture source, with the "In Amber" marker |
| `10-latest-fetching-<theme>.png` | Reader on a live story that is not in Amber: summary + "Fetching the full article…" (dark pass) |
| `11-latest-reader-fetched-<theme>.png` | the same story once Amber has captured it |
| `12-latest-reader-amber-down-<theme>.png` | the calm failure state when Amber is stopped |
| `13-today-open-url-reader.png` | Reader opened by a `homepage:open-url` message from a stored Today page: summary state, "Fetch full article" button |
| `16-latest-all-sources-blocked-<theme>.png` | every source on the blocked list: the "Every source is on your blocked list." notice (dark pass) |
| `17-settings-private-feed-refused-<theme>.png` | Settings refusing a feed on a loopback address with a plain explanation (dark pass) |
| `18-latest-reader-capture-in-progress-<theme>.png` | a look-up that finds Amber already capturing: the capturing state, no Fetch button (dark pass) |
| `19-capture-stub-notice-<theme>.png` | the stub notice with Try capturing again / Capture with my browser / Open original |
| `19-capture-fetching-<theme>.png` | "Capturing with your browser…" / "Opening the page in your browser…" |
| `20-capture-success-<theme>.png` | the full text after the browser capture, with "In Amber" links |
| `21-capture-still-paywalled-<theme>.png` | "Your browser also got a subscription prompt. Are you signed in to <host>?" with Open original |
| `22-capture-amber-needs-update-dark.png` | an Amber without the import API (stubbed 404): "Update Amber to use this." |
| `23-capture-off-site-<theme>.png` | a sign-in redirect to another site: "The page sent your browser to <host>. Sign in there first, then try again." |
| `24-capture-saved-unreadable-dark.png` | the page is saved but its text read-back failed (stubbed): "Saved to Amber, but couldn't read it back." with Try again |
| `15-settings-save-and-rebuild.png` | Settings after editing the instructions: Cancel, Save, Save & rebuild |
| `14-latest-probe-paywalled-dark.png` | (`--probe-paywall`) what a paywalled publisher's capture returns |
| `01-library-<theme>.png` | Library, all sources |
| `02-library-source-chip-<theme>.png` | one source chip active |
| `03-library-search-<theme>.png` | search results (after pressing `/` and typing) |
| `04-reader-<theme>.png` | Reader on the newest article |
| `05-settings-<theme>.png` | Settings modal |
| `06-today-empty-<theme>.png` | Today tab with no API key |
| `07-amber-down-<theme>.png` | Library when the archive is unreachable |

Open each PNG with the Read tool and look at it. Passing assertions do not replace looking.

## What to look for

1. Dark theme: warm near-black background (about `rgb(22, 20, 18)`), not cold grey or pure black. Light theme: warm paper, not stark white.
2. Reader body: serif (Charter), about 20px, line length 62-70ch, generous line height, text contrast at least 7:1 (the script prints the measured value).
3. One accent colour only (amber in dark, darker amber in light), used for the active tab, active chip, links and the primary button. No second highlight colour.
4. Metadata (source, author, minutes, dates) is quiet: smaller, muted, monospace or small caps, and clearly below the titles in weight. It must still be readable.
5. No horizontal overflow or clipped text in the Settings modal, chips, or long titles; the modal scrolls vertically instead.
6. Reader state: top bar is inert behind it (asserted), focus returns to the opened row on close, and the counter reads "1 of N".
7. Amber-down: a clear "Amber isn't running" message with the address it tried and a Retry button, not a blank page or a stack trace.
8. Today with no key: the "Connect your Anthropic API key" setup screen, same typography as the rest.
9. Anything you changed looks the same in light and dark. Compare the two files side by side.

## Assertions it prints

"Capture with my browser": no button on a readable article or on "Fetch full article", walking to a stub with j shows the button and imports nothing, a stub shows exactly the three buttons, no import request before the click, exactly one after it with the story address, raw HTML (scripts included) and `application/json`, the page was loaded with the member cookie (never anonymously), a background window exists while capturing and is gone afterwards, nothing goes through `/api/save`, the text shows and the row says "In Amber" without a reload, a second visit after a reload imports nothing, closing the Reader mid-capture closes the window and sends nothing, a locked story reports the still-paywalled notice naming the host, the capture's tab is muted, the import carries `final_url`, a page with a lone UTF-16 surrogate imports (sent as U+FFFD), a redirect to another site (SSO fixture) is refused naming that host with nothing imported, closing the capture's tab ends it at once with "The page was closed", stubbed import answers show "Update Amber to use this." (404) and "too large" (413) with no retry button, "Amber is busy." (429) and "Amber answered 500" with the retry, a stubbed 503 on the text read-back shows "Saved to Amber, but couldn't read it back" with the story marked "In Amber" and a Try again that re-reads without importing again, and a Today-opened address shows in full above the buttons; then Latest is the default tab, Latest rows > 0, chips with counts, loading Latest saves nothing, an archived story shows "In Amber" and reads straight from Amber, a chip and search narrow Latest, pressing j ten times in the Reader saves nothing and starts no fetch, a future-dated story is filed under "Date unknown", day groups are unique, a second new tab shows the stored fetch with zero feed requests while refresh does refetch (also while one feed is down, and after that feed's Retry, which is written back to the stored fetch), the stored fetch is bounded (at most 20 stories per source, under 1.5 MB), stories on a blocked site are not shown, a source on the blocked list or with a private feed address is never requested, and with every source blocked Latest says so and clears the stored fetch, Enter opens the focused row (Latest and Library), a look-up that finds a capture under way shows the capturing state without a save request, after a failed "Fetch full article" walking j then k sends no new POST /api/save, Esc then clicking a Today story again reopens the Reader, Settings refuses a private feed address, stories appear before the slowest feed answers (soft), a live story saves exactly one snapshot and the full text arrives, it becomes "In Amber" without a reload, the Amber-stopped failure state offers Try again and Open original, `homepage:open-url` opens the Reader only for a real address (not `javascript:` or loopback), turns `%27` into an apostrophe and saves nothing; Settings offers only Save until the instructions change, and plain Save starts no build; `homepage:open-article` from the visible Today frame opens the archived story; then Library rows > 0, a source chip filters the list, `/` focuses search and search narrows the list, Esc clears it, Reader has more than 3 paragraphs and starts at the top, `.shell-content` (which contains the top bar) is `inert` while the Reader is open, Reader font size / measure / contrast (warnings, not failures), no horizontal overflow in Settings, Today shows the API-key screen, Amber-down notice shows, and no console errors from the extension page (network errors during the Amber-down shots are ignored).

## Attach proof to a PR

These screenshots show the user's real reading list: titles, authors and sources of articles they saved. That is personal data, and the fork is public. **Ask the user before posting any of them**, and prefer posting only the shots that need to be seen (for example Settings, Today and Amber-down contain no articles).

When the user agrees:

1. Never commit the images. Keep them in the temp or `--out` folder.
2. Open the PR in Claude in Chrome, find the comment box's file input, and `file_upload` each PNG. GitHub inserts an `<img src="https://github.com/user-attachments/assets/...">` per file.
3. Caption each image with what it proves, with "Before" and "After" when a change replaces something (run the script on the base branch build for "before", with a different `--out`).
4. Click Comment.

If Chrome is not available, tell the user where the screenshots are.

## Caveats

- The Latest checks use the REAL feeds (network needed), so counts and stories change every run; the save flow does a real capture, which can fail or come back as a paywall stub. A fixture feed makes the marker and the failure path deterministic.
- No API key in the throwaway profile (the open-url check stores a dummy one and removes it), so the Today build is not exercised. This verifies the Library, Reader, Settings, Today's empty state and the Amber-down state only. A real build needs `pnpm agent:run` or the extension with a key, and spends credits.
- The browser-capture fixture articles land in the data COPY and become the newest Library rows, so the Library "newest article" Reader shot shows one of them. The flow needs network for Amber's DNS check of `example.org`. A second Amber-side run on the same port while another agent or run uses it gives bogus "Amber isn't running" results: pick a free `--port`.
- Amber must have the JSON API (`/api/snapshots`). If it answers 404 the script captures the "no article API" notice and skips the chip, search and Reader checks; update the checkout and rerun. An empty `data/` dir produces an empty Library, which fails "Library has rows".
- `--amber-dir` must contain `.venv/bin/python`. A fresh `git worktree` has neither the venv nor data.
- Chrome 136+ ignores `--load-extension`, so the extension is loaded through the CDP `Extensions` domain with `--enable-unsafe-extension-debugging`; this is why the script owns its own Chrome instead of using your normal profile.
- The Library shows the last 90 days of snapshots; the numbers in the screenshots change as the archive grows.
