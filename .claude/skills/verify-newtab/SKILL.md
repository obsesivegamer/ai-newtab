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
| `--amber-dir <path>` | `~/Documents/amber-archive` | Amber checkout to run (needs the JSON API, and `/api/lookup` + `/api/save` for the save flow: Amber PR #17) |
| `--python <path>` | `<amber-dir>/.venv/bin/python` | interpreter with Amber's dependencies and Chromium (a fresh worktree has no `.venv`) |
| `--data-from <dir>` | `<amber-dir>/data` | the data dir to COPY; the copy is what Amber runs on and is deleted on exit |
| `--no-save` | off | skip the Latest -> Reader save/capture flow (it does a real capture of a live Guardian/Ars/BBC story) |
| `--probe-paywall` | off | also open an un-archived NYT/FT/WSJ story and report what the capture returns |
| `--port <n>` | `8090` | port for the throwaway Amber; `8080` is refused. Pick another if something already answers |
| `--build` | off | run `npx -y pnpm@10.11.1 build` first |
| `--chrome-port <n>` | random free port | Chrome DevTools port |

`CHROME_PATH` overrides the Chrome binary (default is the macOS Google Chrome path). The script warns when the build is older than the source, so a stale build does not pass for your change. It takes about 15 seconds and exits 0 only when no hard assertion failed.

What it does: copies `--data-from` to a temp dir, starts `python -m uvicorn app.main:app` on `--port` with `AMBER_DATA_DIR` set to the copy (so the save flow never writes to the real data), blocks `:8080` in the page before `archiveUrl` is set, sets `archiveUrl` in the fresh profile's `chrome.storage.local`, then captures 1280x900 at 2x for each of the following in **dark and light**. Amber and Chrome are always killed on exit, on error, and on SIGINT/SIGTERM. It never touches port 8080 or Amber's launchd service.

The only POST is the Latest save flow (`/api/save` on the throwaway Amber, one live story), and it lands in the copy. A local fixture feed (a small Bun server) supplies two stories Amber already has, one it does not, one it cannot capture (an unresolvable host: Amber answers 400) and one dated in the future. Chrome is started with `--host-resolver-rules` so the fixture is served as `verify-fixture.example`: feed addresses on loopback are refused by design, so a `127.0.0.1` fixture would never be fetched. A second fixture feed ("Verify flaky") answers 503 until the script flips it, and a `127.0.0.1` feed is used to prove private addresses are not requested.

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

Latest is the default tab, Latest rows > 0, chips with counts, loading Latest saves nothing, an archived story shows "In Amber" and reads straight from Amber, a chip and search narrow Latest, pressing j ten times in the Reader saves nothing and starts no fetch, a future-dated story is filed under "Date unknown", day groups are unique, a second new tab shows the stored fetch with zero feed requests while refresh does refetch (also while one feed is down, and after that feed's Retry, which is written back to the stored fetch), the stored fetch is bounded (at most 20 stories per source, under 1.5 MB), stories on a blocked site are not shown, a source on the blocked list or with a private feed address is never requested, and with every source blocked Latest says so and clears the stored fetch, Enter opens the focused row (Latest and Library), a look-up that finds a capture under way shows the capturing state without a save request, after a failed "Fetch full article" walking j then k sends no new POST /api/save, Esc then clicking a Today story again reopens the Reader, Settings refuses a private feed address, stories appear before the slowest feed answers (soft), a live story saves exactly one snapshot and the full text arrives, it becomes "In Amber" without a reload, the Amber-stopped failure state offers Try again and Open original, `homepage:open-url` opens the Reader only for a real address (not `javascript:` or loopback), turns `%27` into an apostrophe and saves nothing; Settings offers only Save until the instructions change, and plain Save starts no build; `homepage:open-article` from the visible Today frame opens the archived story; then Library rows > 0, a source chip filters the list, `/` focuses search and search narrows the list, Esc clears it, Reader has more than 3 paragraphs and starts at the top, `.shell-content` (which contains the top bar) is `inert` while the Reader is open, Reader font size / measure / contrast (warnings, not failures), no horizontal overflow in Settings, Today shows the API-key screen, Amber-down notice shows, and no console errors from the extension page (network errors during the Amber-down shots are ignored).

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
- Amber must have the JSON API (`/api/snapshots`). If it answers 404 the script captures the "no article API" notice and skips the chip, search and Reader checks; update the checkout and rerun. An empty `data/` dir produces an empty Library, which fails "Library has rows".
- `--amber-dir` must contain `.venv/bin/python`. A fresh `git worktree` has neither the venv nor data.
- Chrome 136+ ignores `--load-extension`, so the extension is loaded through the CDP `Extensions` domain with `--enable-unsafe-extension-debugging`; this is why the script owns its own Chrome instead of using your normal profile.
- The Library shows the last 90 days of snapshots; the numbers in the screenshots change as the archive grows.
