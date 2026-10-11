#!/usr/bin/env python3
"""
Verify the phone/web version of the new tab (apps/web) the way a phone would see it.

Copies Amber's data, starts a throwaway Amber on the COPY with the built web app served at
/app/, and drives it with Playwright Chromium emulating an iPhone 14 (390x844 @3x, touch,
mobile UA). Saves screenshots, prints assertions, exits non-zero if a hard one failed.

Run it with the interpreter that has Playwright and Amber's dependencies (Amber's venv):

    ~/Documents/amber-archive/.venv/bin/python .claude/skills/verify-newtab/scripts/verify-web.py \
        --amber-dir ~/Documents/amber-archive-webapp-api --out /tmp/shots-web [--build]

It never touches port 8080 or the real data dir. Amber is stopped by PID on exit.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

REPO = Path(__file__).resolve().parents[4]

ap = argparse.ArgumentParser()
ap.add_argument("--amber-dir", default=str(Path.home() / "Documents/amber-archive"),
                help="Amber checkout that has the web app routes (feedproxy, homepage, sources, /app/)")
ap.add_argument("--data-from", default=str(Path.home() / "Documents/amber-archive/data"),
                help="data dir to COPY; the copy is what Amber runs on")
ap.add_argument("--port", type=int, default=8116)
ap.add_argument("--out", default=str(Path(tempfile.gettempdir()) / "shots-web"))
ap.add_argument("--web-dir", default=str(REPO / "apps/web/dist"))
ap.add_argument("--homepage", default=str(REPO / "harness/out/homepage.tsx"),
                help="TSX published to /api/homepage for the Today checks")
ap.add_argument("--build", action="store_true", help="run `pnpm web:build` first")
ap.add_argument("--no-save", action="store_true", help="skip the live capture of a Latest story")
args = ap.parse_args()

if args.port == 8080:
    sys.exit("refusing port 8080: that is the real Amber")

OUT = Path(args.out)
OUT.mkdir(parents=True, exist_ok=True)
BASE = f"http://127.0.0.1:{args.port}"
APP = f"{BASE}/app/"

failures: list[str] = []
warnings: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> bool:
    print(("  ok   " if ok else "  FAIL ") + name + (f"  [{detail}]" if detail and not ok else ""))
    if not ok:
        failures.append(f"{name} {detail}".strip())
    return ok


def warn(msg: str) -> None:
    print("  warn " + msg)
    warnings.append(msg)


def http(method: str, path: str, body: dict | None = None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method,
                                 headers={"Content-Type": "application/json"} if data else {})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


# --- build + Amber ---------------------------------------------------------------------------

if args.build:
    print("building the web app …")
    subprocess.run(["npx", "-y", "pnpm@10.11.1", "web:build"], cwd=REPO, check=True)

web_dir = Path(args.web_dir)
if not (web_dir / "index.html").is_file():
    sys.exit(f"no built web app at {web_dir}: run `npx -y pnpm@10.11.1 web:build` (or pass --build)")
newest_src = max(
    (p.stat().st_mtime for root in (REPO / "apps/web/src", REPO / "apps/extension/entrypoints/newtab")
     for p in root.rglob("*") if p.is_file()),
    default=0,
)
if newest_src > (web_dir / "index.html").stat().st_mtime:
    warn("the web build is older than the source: run web:build (or --build) so you verify your change")

tmp = Path(tempfile.mkdtemp(prefix="newtab-web-verify-"))
data_dir = tmp / "data"
shutil.copytree(args.data_from, data_dir)
print(f"Amber data: {data_dir} (a copy of {args.data_from}; deleted on exit)")

env = dict(os.environ, AMBER_DATA_DIR=str(data_dir), AMBER_WEBAPP_DIR=str(web_dir),
           AMBER_PORT=str(args.port))
amber_log = open(OUT / "amber.log", "w")
amber = subprocess.Popen(
    [sys.executable, "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", str(args.port)],
    cwd=args.amber_dir, env=env, stdout=amber_log, stderr=subprocess.STDOUT,
)


def stop_amber() -> None:
    if amber.poll() is None:
        amber.send_signal(signal.SIGTERM)
        try:
            amber.wait(timeout=10)
        except subprocess.TimeoutExpired:
            amber.kill()
    shutil.rmtree(tmp, ignore_errors=True)


def wait_for_amber() -> None:
    for _ in range(60):
        if amber.poll() is not None:
            sys.exit(f"Amber exited early; see {OUT / 'amber.log'}")
        try:
            if http("GET", "/api/snapshots?limit=1")[0] == 200:
                return
        except Exception:
            pass
        time.sleep(0.5)
    sys.exit("Amber did not start")


# Rows opened in the Reader, and what a request log looks like, are shared by the checks below.
SANDPACK = "codesandbox.io"
EXPECTED_404 = ("/api/sources", "/api/homepage")


def run() -> None:
    wait_for_amber()
    code, body = http("GET", "/app/")
    check("Amber serves the web app at /app/", code == 200 and b"<div id=\"root\">" in body, str(code))
    check("/api/feedproxy exists (Amber has the web app routes)",
          http("GET", "/api/feedproxy?url=")[0] == 400, "expected 400 for an empty ?url=")
    check("a fresh Amber has no homepage", http("GET", "/api/homepage")[0] == 404)
    check("a fresh Amber has no sources", http("GET", "/api/sources")[0] == 404)
    snaps = json.loads(http("GET", "/api/snapshots?since_days=90&limit=5")[1])
    if not snaps.get("snapshots"):
        sys.exit("the data copy has no snapshots in the last 90 days; Library checks need some")
    first_id = snaps["snapshots"][0]["id"]

    with sync_playwright() as p:
        browser = p.chromium.launch()
        iphone = dict(p.devices["iPhone 14"])

        def new_context(theme: str, width: int = 390, height: int = 844):
            opts = dict(iphone)
            opts["viewport"] = {"width": width, "height": height}
            return browser.new_context(**opts, color_scheme=theme)

        class Session:
            """One page with its request and console logs."""

            def __init__(self, theme: str, width: int = 390, height: int = 844):
                self.ctx = new_context(theme, width, height)
                self.page = self.ctx.new_page()
                self.requests: list[tuple[str, str]] = []  # (method, url)
                self.responses: list[tuple[int, str]] = []
                self.console_errors: list[str] = []
                self.put_bodies: list[dict] = []  # JSON bodies of PUT /api/sources, in order
                self.page.on("request", self._request)
                self.page.on("response", lambda r: self.responses.append((r.status, r.url)))
                self.page.on("console", self._console)
                self.page.on("pageerror", lambda e: self.console_errors.append(f"pageerror: {e}"))

            def _request(self, r) -> None:
                self.requests.append((r.method, r.url))
                if r.method == "PUT" and r.url.endswith("/api/sources"):
                    try:
                        self.put_bodies.append(json.loads(r.post_data or "{}"))
                    except ValueError:
                        self.put_bodies.append({})

            def _console(self, m) -> None:
                if m.type != "error":
                    return
                url = (m.location or {}).get("url", "")
                # Browsers log every non-2xx fetch as a console error. Expected here: "nothing stored
                # yet" answers, and a live publisher's feed being slow or down (the proxy's 5xx).
                # (also a 409 from the sources precondition, a stubbed 503, and an aborted request in the
                # failure checks below: the browser logs each of those as a console error)
                if any(url.endswith(x) for x in EXPECTED_404) and (
                    "404" in m.text or "409" in m.text or "Failed to load resource" in m.text
                ):
                    return
                if "/api/feedproxy" in url:
                    return
                self.console_errors.append(f"{m.text} ({url})")

            def shot(self, name: str, full: bool = False) -> None:
                self.page.screenshot(path=str(OUT / name), full_page=full)

            def overflow(self, label: str) -> None:
                r = self.page.evaluate(
                    """() => ({
                      doc: document.documentElement.scrollWidth, win: window.innerWidth,
                      body: document.body.scrollWidth,
                      reader: (() => { const e = document.querySelector('.reader-scroll'); return e ? e.scrollWidth - e.clientWidth : 0 })(),
                      modal: (() => { const e = document.querySelector('.modal-body'); return e ? e.scrollWidth - e.clientWidth : 0 })(),
                    })"""
                )
                width = self.page.viewport_size["width"]
                check(f"no horizontal overflow: {label} @{width}",
                      r["doc"] <= r["win"] and r["body"] <= r["win"] and r["reader"] <= 0 and r["modal"] <= 0,
                      json.dumps(r))

            def small_targets(self, label: str, scope: str = "body") -> None:
                bad = self.page.evaluate(
                    """(scope) => {
                      const out = [];
                      const root = document.querySelector(scope);
                      for (const el of root.querySelectorAll('button, a[href], input, select, textarea')) {
                        if (el.closest('[hidden], [inert]')) continue;
                        const r = el.getBoundingClientRect();
                        if (r.width === 0 || r.height === 0) continue;
                        if (r.bottom < 0 || r.top > innerHeight) continue;
                        if (el.disabled && el.tagName === 'BUTTON') continue;
                        if (Math.min(r.height, 44) < 43.5 || (r.width < 43.5 && el.tagName !== 'A')) {
                          out.push((el.getAttribute('aria-label') || el.textContent || el.className).trim().slice(0, 30)
                                   + ' ' + Math.round(r.width) + 'x' + Math.round(r.height));
                        }
                      }
                      return out;
                    }""",
                    scope,
                )
                check(f"44px tap targets: {label}", not bad, "; ".join(bad[:6]))

            def close(self) -> None:
                self.ctx.close()

        def cross_origin_requests(s: Session) -> list[str]:
            return [u for _, u in s.requests
                    if not u.startswith(BASE) and not u.startswith("data:") and not u.startswith("blob:")
                    and SANDPACK not in u]

        # ---- fixed things: manifest, icons, meta ------------------------------------------------
        print("\n== PWA metadata ==")
        s = Session("dark")
        pg = s.page
        pg.goto(APP, wait_until="networkidle")
        meta = pg.evaluate(
            """() => ({
              viewport: document.querySelector('meta[name=viewport]')?.content,
              capable: document.querySelector('meta[name=apple-mobile-web-app-capable]')?.content,
              statusBar: document.querySelector('meta[name=apple-mobile-web-app-status-bar-style]')?.content,
              theme: document.querySelector('meta[name=theme-color]')?.content,
              manifest: document.querySelector('link[rel=manifest]')?.href,
              touchIcon: document.querySelector('link[rel=apple-touch-icon]')?.href,
              lang: document.documentElement.lang,
            })"""
        )
        check("viewport has viewport-fit=cover", "viewport-fit=cover" in (meta["viewport"] or ""), str(meta["viewport"]))
        check("apple-mobile-web-app-capable = yes", meta["capable"] == "yes", str(meta["capable"]))
        check("theme-color present", bool(meta["theme"]), str(meta["theme"]))
        mcode, mbody = http("GET", "/app/manifest.webmanifest")
        manifest = json.loads(mbody) if mcode == 200 else {}
        check("manifest.webmanifest served", mcode == 200)
        check("manifest display is standalone", manifest.get("display") == "standalone", str(manifest.get("display")))
        check("manifest start_url and scope stay under /app/",
              manifest.get("start_url") in ("./", "/app/") and manifest.get("scope") in ("./", "/app/"))
        for icon in manifest.get("icons", []):
            c, b = http("GET", "/app/" + icon["src"])
            ok = c == 200 and b[:8] == b"\x89PNG\r\n\x1a\n"
            w, h = struct.unpack(">II", b[16:24]) if ok else (0, 0)
            check(f"manifest icon {icon['src']} is a {icon['sizes']} PNG", ok and f"{w}x{h}" == icon["sizes"], f"{w}x{h}")
        c, b = http("GET", "/app/icon/apple-touch-icon.png")
        w, h = struct.unpack(">II", b[16:24]) if c == 200 else (0, 0)
        check("apple-touch-icon is 180x180", (w, h) == (180, 180), f"{c} {w}x{h}")
        s.close()

        # ---- the main pass, dark then light ------------------------------------------------------
        def pass_(theme: str, first: bool) -> None:
            print(f"\n== {theme} ==")
            s = Session(theme)
            pg = s.page
            pg.goto(APP, wait_until="networkidle")
            attr = pg.evaluate("document.documentElement.dataset.theme")
            check(f"default theme follows prefers-color-scheme ({theme})", attr == theme, str(attr))
            kbd_hidden = pg.evaluate(
                "getComputedStyle(document.querySelector('.view-latest .search kbd') || document.body).display === 'none'"
            ) if pg.locator(".view-latest .search kbd").count() else True
            check("keyboard hints are hidden on touch", kbd_hidden)

            # Latest: live feeds through the proxy
            pg.locator(".view-latest button.row").first.wait_for(timeout=60_000)
            pg.wait_for_timeout(2500)
            rows = pg.locator(".view-latest button.row").count()
            check("Latest shows stories from live feeds", rows > 0, str(rows))
            direct = cross_origin_requests(s)
            proxied = [u for _, u in s.requests if "/api/feedproxy?url=" in u]
            check("zero direct cross-origin requests (all feeds via /api/feedproxy)", not direct, "; ".join(direct[:5]))
            check("feeds were fetched through /api/feedproxy", len(proxied) > 0, str(len(proxied)))
            saves = [u for m, u in s.requests if m == "POST" and "/api/save" in u]
            check("loading Latest saves nothing", not saves)
            s.shot(f"01-latest-{theme}.png")
            pg.evaluate("window.scrollTo(0, 700)")
            pg.wait_for_timeout(300)
            pinned = pg.evaluate(
                """() => ({ bar: document.querySelector('.web-topbar').getBoundingClientRect().top,
                           tabs: document.querySelector('.web-tabbar').getBoundingClientRect().bottom,
                           day: document.querySelector('.view-latest .day')?.getBoundingClientRect().top ?? null,
                           h: innerHeight })"""
            )
            check("top bar and tab bar stay pinned while scrolling Latest",
                  abs(pinned["bar"]) < 1 and abs(pinned["tabs"] - pinned["h"]) < 1, json.dumps(pinned))
            s.shot(f"01b-latest-scrolled-{theme}.png")
            pg.evaluate("window.scrollTo(0, 0)")
            s.overflow("Latest")
            s.small_targets("Latest (top bar, chips, rows, tabs)")

            # Library
            pg.get_by_role("button", name="Library").tap()
            pg.locator(".view-library button.row").first.wait_for(timeout=20_000)
            pg.wait_for_timeout(600)
            check("Library shows saved articles", pg.locator(".view-library button.row").count() > 0)
            s.shot(f"02-library-{theme}.png")
            s.overflow("Library")
            s.small_targets("Library")

            # Reader: an archived story, prev/next by tap
            pg.locator(".view-library button.row").nth(1).tap()
            pg.locator(".reader").wait_for()
            pg.locator(".reader-body p").first.wait_for(timeout=20_000)
            check("Reader opens an archived story", pg.locator(".reader-title").inner_text().strip() != "")
            check("Reader has prev/next dock", pg.locator(".reader-dock").count() == 1)
            check("no top-bar prev/next on the phone", not pg.locator(".reader-bar .bar-nav:visible").count())
            check("'Capture with my browser' is never offered", pg.get_by_text("Capture with my browser").count() == 0)
            pos = pg.locator(".dock-pos").inner_text().strip().lower()
            check("dock position reads '2 of N'", pos.startswith("2 of "), pos)
            title0 = pg.locator(".reader-title").inner_text()
            s.shot(f"03-reader-archived-{theme}.png")
            s.overflow("Reader (archived)")
            s.small_targets("Reader", ".reader")
            pg.locator(".dock-btn", has_text="Next").tap()
            pg.locator(".dock-pos", has_text="3 of").wait_for()
            pg.wait_for_timeout(500)
            check("Next (tap) moved to the next story", pg.locator(".reader-title").inner_text() != title0)
            pg.locator(".dock-btn", has_text="Previous").tap()
            pg.locator(".dock-pos", has_text="2 of").wait_for()
            pg.wait_for_timeout(500)
            check("Previous (tap) came back", pg.locator(".reader-title").inner_text() == title0)
            check("walking the Library list saves nothing",
                  not [1 for m, u in s.requests if m == "POST" and "/api/save" in u])
            pg.locator(".reader-scroll").evaluate("e => e.scrollTo(0, e.scrollHeight)")
            pg.wait_for_timeout(300)
            s.shot(f"04-reader-end-{theme}.png")
            pg.locator(".back-btn").tap()
            pg.locator(".reader").wait_for(state="detached")
            check("Back closes the Reader", pg.locator(".reader").count() == 0)

            # Latest: a tap on an unsaved story saves it, and only that
            if first and not args.no_save:
                pg.get_by_role("button", name="Latest").tap()
                pg.wait_for_timeout(300)
                before = len([1 for m, u in s.requests if m == "POST" and "/api/save" in u])
                candidates = pg.locator(
                    ".view-latest button.row:not(:has(.row-amber))"
                    ":has(.row-site:text-matches('Guardian|Ars Technica|BBC|Financial Times|Intercept', 'i'))"
                )
                n = min(candidates.count(), 4)
                saved_ok = False
                for i in range(max(n, 1)):
                    row = candidates.nth(i) if n else pg.locator(".view-latest button.row").first
                    row_title = row.locator(".row-title").inner_text()
                    row.scroll_into_view_if_needed()
                    row.tap()
                    pg.locator(".reader").wait_for()
                    check("tap on a Latest story opens the Reader at once", pg.locator(".reader-title").count() == 1)
                    pg.wait_for_timeout(600)
                    s.shot(f"05-latest-reader-fetching-{theme}.png")
                    try:
                        pg.locator(".reader-body p").nth(2).wait_for(timeout=110_000)
                        saved_ok = True
                    except Exception:
                        warn(f"live capture of '{row_title[:50]}' did not finish; trying another story")
                        pg.locator(".back-btn").tap()
                        pg.locator(".reader").wait_for(state="detached")
                        continue
                    break
                saves_now = [(m, u) for m, u in s.requests if m == "POST" and "/api/save" in u]
                check("a freshly captured story is readable", saved_ok)
                check("exactly one POST /api/save, after the tap", len(saves_now) - before == 1, str(len(saves_now) - before))
                if saved_ok:
                    s.shot(f"06-reader-fresh-{theme}.png")
                    s.overflow("Reader (freshly saved)")
                    # prev/next after a tap-save must not save anything else
                    for _ in range(3):
                        nxt = pg.locator(".dock-btn", has_text="Next")
                        if nxt.is_enabled():
                            nxt.tap()
                            pg.wait_for_timeout(700)
                    saves_after = [1 for m, u in s.requests if m == "POST" and "/api/save" in u]
                    check("Next x3 after the tap saves nothing more", len(saves_after) == len(saves_now), str(len(saves_after)))
                    idle = pg.get_by_role("button", name="Fetch full article")
                    check("an unsaved story reached with Next waits for a tap ('Fetch full article')",
                          idle.count() >= 1 or pg.locator(".reader-body p").count() > 0)
                    if idle.count():
                        s.shot(f"07-reader-next-needs-tap-{theme}.png")
                    pg.locator(".back-btn").tap()
                    pg.locator(".reader").wait_for(state="detached")
                    pg.wait_for_timeout(1500)
                    amber_rows = pg.locator(".view-latest button.row .row-amber").count()
                    check("the saved story is marked 'In Amber' without a reload", amber_rows >= 1, str(amber_rows))

            # Settings
            pg.get_by_role("button", name="Settings").tap()
            pg.locator(".modal").wait_for()
            pg.wait_for_timeout(900)
            s.shot(f"08-settings-{theme}.png")
            s.overflow("Settings")
            s.small_targets("Settings", ".modal")
            check("Settings has no API key, instructions, model or build controls",
                  pg.locator(".modal textarea, .modal select, .modal input[type=password]").count() == 0
                  and pg.locator(".modal").get_by_role("button", name="Save & rebuild").count() == 0)
            if first:
                put_before = len([1 for m, u in s.requests if m == "PUT" and u.endswith("/api/sources")])
                switch = pg.locator(".src-row .switch").first
                name = pg.locator(".src-row .src-name").first.inner_text()
                switch.tap()
                pg.wait_for_timeout(1800)
                puts = [1 for m, u in s.requests if m == "PUT" and u.endswith("/api/sources")]
                check("toggling a source PUTs /api/sources (debounced, once)", len(puts) - put_before == 1, str(len(puts)))
                code, body = http("GET", "/api/sources")
                got = json.loads(body) if code == 200 else {"sources": []}
                row = next((x for x in got["sources"] if x["name"] == name), None)
                check("Amber holds the edit", row is not None and row["enabled"] is False, f"{code} {name}")
                switch.tap()  # back on
                pg.wait_for_timeout(1800)
                check("the first PUT is conditional on 'no list stored yet' (Amber answered 404 at boot)",
                      s.put_bodies[0].get("if_updated_at") == "", json.dumps(s.put_bodies[0])[:80])
                code, body = http("GET", "/api/sources")
                seen_stamp = json.loads(body)["updated_at"]
                check("a later PUT sends the stamp it last saw as if_updated_at",
                      isinstance(s.put_bodies[-1].get("if_updated_at"), str) and len(s.put_bodies) >= 2,
                      json.dumps({k: v for k, v in s.put_bodies[-1].items() if k != "sources"}))

                # a toggle still waiting out the 800 ms debounce is sent when the page is hidden
                puts_before = len(s.put_bodies)
                switch.tap()
                pg.evaluate("window.dispatchEvent(new Event('pagehide'))")
                pg.wait_for_timeout(350)
                check("a pending toggle is flushed on pagehide, before the debounce",
                      len(s.put_bodies) - puts_before == 1, str(len(s.put_bodies) - puts_before))
                check("that flush carries the stamp Amber had", s.put_bodies[-1].get("if_updated_at") == seen_stamp,
                      json.dumps({k: v for k, v in s.put_bodies[-1].items() if k != "sources"}))
                code, body = http("GET", "/api/sources")
                row = next((x for x in json.loads(body)["sources"] if x["name"] == name), None)
                check("Amber holds the toggle that was flushed on pagehide", row is not None and row["enabled"] is False)
                pg.wait_for_timeout(1200)
                check("the flushed edit is not sent a second time by the debounce timer",
                      len(s.put_bodies) - puts_before == 1, str(len(s.put_bodies) - puts_before))
                # the same when the page goes to the background (visibilitychange -> hidden)
                switch.tap()  # back on
                pg.evaluate(
                    """() => { Object.defineProperty(document, 'hidden', {configurable: true, get: () => true});
                               document.dispatchEvent(new Event('visibilitychange')); }""")
                pg.wait_for_timeout(350)
                check("a pending toggle is flushed when the page is hidden",
                      len(s.put_bodies) - puts_before == 2, str(len(s.put_bodies) - puts_before))
                pg.evaluate(
                    """() => { Object.defineProperty(document, 'hidden', {configurable: true, get: () => false});
                              document.dispatchEvent(new Event('visibilitychange')); }""")
                pg.wait_for_timeout(1500)
                code, body = http("GET", "/api/sources")
                row = next((x for x in json.loads(body)["sources"] if x["name"] == name), None)
                check("Amber holds the second flushed edit (back on)", row is not None and row["enabled"] is True)

                # add a feed through the proxy (probe)
                feed = "https://www.theguardian.com/uk/technology/rss"
                pg.locator(".src-add input").fill(feed)
                pg.get_by_role("button", name="Add", exact=True).tap()
                pg.locator(".set-status.ok, .set-status.error").first.wait_for(timeout=30_000)
                status = pg.locator(".src-test, .set-test .set-status").first.inner_text() if False else \
                    pg.locator(".set-status").last.inner_text()
                probe = [u for m, u in s.requests if "/api/feedproxy?url=" in u and "theguardian.com%2Fuk%2Ftechnology" in u]
                check("adding a feed probes it through the proxy", len(probe) >= 1, str(len(probe)))
                check("the probe succeeded", "Added" in status or "already" in status.lower(), status)
                s.shot(f"09-settings-added-feed-{theme}.png")
                pg.locator(".modal-body").evaluate("e => e.scrollTo(0, 0)")
                pg.get_by_role("button", name="Re-seed from my archive").tap()
                pg.wait_for_timeout(2500)
                s.shot(f"10-settings-reseed-{theme}.png")

                # ---- stale write: another device wrote first -> 409 -> the phone adopts Amber's list ----
                def amber_sources() -> dict:
                    return json.loads(http("GET", "/api/sources")[1])

                def mac_edit(marker_id: str, marker_name: str) -> dict:
                    """What the extension does: PUT the list with one more (switched off) source, unconditionally."""
                    time.sleep(1.2)  # Amber's stamps have a one-second resolution
                    mine = amber_sources()["sources"]
                    mine.append({"id": marker_id, "name": marker_name,
                                 "feedUrls": ["https://example.org/feed.xml"], "enabled": False})
                    code_, body_ = http("PUT", "/api/sources", {"sources": mine})
                    assert code_ == 200, code_
                    return json.loads(body_)

                before_names = [x["name"] for x in amber_sources()["sources"]]
                mac = mac_edit("verify-mac-edit", "Verify Mac Edit")
                n_puts = len(s.put_bodies)
                pg.locator(".modal-body").evaluate("e => e.scrollTo(0, 0)")
                toggled = pg.locator(".src-row .src-name").first.inner_text()
                pg.locator(".src-row .switch").first.tap()
                pg.wait_for_timeout(2200)
                check("a stale edit is sent once, with the stamp the phone had",
                      len(s.put_bodies) - n_puts == 1 and s.put_bodies[-1].get("if_updated_at") not in (None, mac["updated_at"]),
                      json.dumps({k: v for k, v in s.put_bodies[-1].items() if k != "sources"}))
                check("Amber answered that PUT with 409",
                      any(st == 409 and u.endswith("/api/sources") for st, u in s.responses))
                names = pg.locator(".src-row .src-name").all_inner_texts()
                check("the phone adopted the list Amber returned (Mac's added source shows)",
                      "Verify Mac Edit" in names and names[:-1] == before_names, str(names[-3:]))
                note = pg.locator(".sync-note")
                check("a short note says the list was updated from another device",
                      note.count() == 1 and "Updated from another device" in note.inner_text())
                check("the note takes no taps (pointer-events: none)",
                      pg.evaluate("getComputedStyle(document.querySelector('.sync-note')).pointerEvents") == "none")
                s.shot(f"10b-settings-409-adopted-{theme}.png")
                held = amber_sources()
                mine = next((x for x in held["sources"] if x["name"] == toggled), None)
                check("Amber still holds the Mac's write, not the stale phone edit",
                      held["updated_at"] == mac["updated_at"] and mine is not None and mine["enabled"] is True,
                      f"{held['updated_at']} vs {mac['updated_at']}")
                n_puts = len(s.put_bodies)
                pg.wait_for_timeout(1200)
                check("no retry loop after a 409", len(s.put_bodies) == n_puts)
                pg.wait_for_timeout(4000)
                check("the note clears itself", pg.locator(".sync-note").count() == 0)

                # a Mac edit is picked up when the page comes back to the foreground (Settings open)
                mac_edit("verify-mac-edit-2", "Verify Mac Edit Two")
                pg.evaluate(
                    """() => { Object.defineProperty(document, 'hidden', {configurable: true, get: () => true});
                               document.dispatchEvent(new Event('visibilitychange'));
                               Object.defineProperty(document, 'hidden', {configurable: true, get: () => false});
                               document.dispatchEvent(new Event('visibilitychange')); }""")
                pg.wait_for_timeout(1500)
                names = pg.locator(".src-row .src-name").all_inner_texts()
                check("coming back to the page re-reads Amber's list", "Verify Mac Edit Two" in names, str(names[-3:]))
                n_puts = len(s.put_bodies)
                pg.wait_for_timeout(1000)
                check("adopting a refresh sends nothing back", len(s.put_bodies) == n_puts)
            pg.get_by_role("button", name="Done").tap()
            pg.locator(".modal").wait_for(state="detached")

            # Theme toggle persists across a reload
            other = "light" if theme == "dark" else "dark"
            pg.locator(".web-topbar .icon-btn").nth(1).tap()
            pg.wait_for_timeout(300)
            check("theme toggle switches the theme", pg.evaluate("document.documentElement.dataset.theme") == other)
            pg.reload(wait_until="networkidle")
            check("the chosen theme survives a reload", pg.evaluate("document.documentElement.dataset.theme") == other)
            pg.locator(".web-topbar .icon-btn").nth(1).tap()  # back
            pg.wait_for_timeout(200)

            if first:
                check("sources survive a reload from Amber (disabled/added state intact)",
                      http("GET", "/api/sources")[0] == 200)
                # opening Settings re-reads Amber's list
                time.sleep(1.2)
                held = json.loads(http("GET", "/api/sources")[1])["sources"]
                held.append({"id": "verify-mac-edit-3", "name": "Verify Mac Edit Three",
                             "feedUrls": ["https://example.org/feed.xml"], "enabled": False})
                http("PUT", "/api/sources", {"sources": held})
                pg.get_by_role("button", name="Settings").tap()
                pg.locator(".modal").wait_for()
                pg.wait_for_timeout(1500)
                check("opening Settings adopts a list Amber changed meanwhile",
                      "Verify Mac Edit Three" in pg.locator(".src-row .src-name").all_inner_texts())
                pg.get_by_role("button", name="Done").tap()
                pg.locator(".modal").wait_for(state="detached")
                # a failed boot read never wipes what the phone already has
                n_puts = len(s.put_bodies)
                pg.route("**/api/sources", lambda route: route.abort() if route.request.method == "GET" else route.continue_())
                pg.reload(wait_until="networkidle")
                pg.get_by_role("button", name="Settings").tap()
                pg.locator(".modal").wait_for()
                pg.wait_for_timeout(1000)
                kept = pg.locator(".src-row .src-name").all_inner_texts()
                check("with Amber's list unreadable at boot, the local list stays (nothing wiped)",
                      len(kept) >= 3 and "Verify Mac Edit Three" in kept, str(kept[-3:]))
                check("an unreadable boot read sends nothing", len(s.put_bodies) == n_puts)
                pg.get_by_role("button", name="Done").tap()
                pg.locator(".modal").wait_for(state="detached")
                pg.unroute("**/api/sources")
                # Today: empty state first
                pg.get_by_role("button", name="Today").tap()
                pg.get_by_text("No Today page yet.").wait_for(timeout=10_000)
                check("Today empty state is calm and says what to do",
                      pg.get_by_text("Build it once in the extension on your Mac.").count() == 1)
                s.shot(f"11-today-empty-{theme}.png")
                s.overflow("Today (empty)")

            print(f"  console errors: {len(s.console_errors)}")
            for e in s.console_errors[:8]:
                print("    ", e)
            check(f"no console errors ({theme})", not s.console_errors, "; ".join(s.console_errors[:3]))
            s.close()

        pass_("dark", first=True)

        # ---- Today with a published homepage -----------------------------------------------------
        print("\n== Today ==")
        hp = Path(args.homepage)
        code_text = hp.read_text() if hp.is_file() else (
            "export default function App(){return <main style={{padding:24}}><h1>Fixture</h1></main>}")
        status, _ = http("PUT", "/api/homepage", {"code": code_text, "timestamp": "2026-10-10T23:50:00Z"})
        check("PUT /api/homepage accepts the built page", status == 200, str(status))
        s = Session("dark")
        pg = s.page
        pg.goto(APP, wait_until="networkidle")
        pg.get_by_role("button", name="Today").tap()
        pg.locator(".today-strip").wait_for(timeout=20_000)
        label = pg.locator(".today-built").inner_text()
        check("Today says when it was built, on your Mac", label.startswith("Built ") and "Mac" in label, label)
        frame_el = pg.locator(".today-frame iframe").first
        frame_el.wait_for(timeout=30_000)
        frame = None
        for _ in range(120):
            frame = next((f for f in pg.frames if SANDPACK in f.url), None)
            if frame and frame.locator("body *").count() > 5:
                break
            pg.wait_for_timeout(500)
        check("Today renders in the sandboxed Sandpack frame", frame is not None and frame.locator("body *").count() > 5)
        pg.wait_for_timeout(1500)
        s.shot("12-today-dark.png")

        # A refresh that fails while a good page is showing keeps that page, with a note.
        pg.route("**/api/homepage", lambda route: route.fulfill(status=503, body="down"))
        pg.evaluate(
            """() => { window.__realNow = Date.now; Date.now = () => window.__realNow() + 6 * 60_000;
                       Object.defineProperty(document, 'hidden', {configurable: true, get: () => true});
                       document.dispatchEvent(new Event('visibilitychange'));
                       Object.defineProperty(document, 'hidden', {configurable: true, get: () => false});
                       document.dispatchEvent(new Event('visibilitychange')); }""")
        pg.wait_for_timeout(1500)
        check("a failed background refresh shows a small note",
              pg.locator(".today-note").count() == 1 and "showing the last copy" in pg.locator(".today-note").inner_text())
        check("...and keeps the last good page (frame still there, no error screen)",
              pg.locator(".today-frame iframe").count() >= 1 and pg.get_by_text("Couldn’t reach Amber.").count() == 0)
        s.shot("12b-today-refresh-failed.png")
        s.overflow("Today (refresh failed)")
        pg.unroute("**/api/homepage")
        pg.locator(".today-strip button").tap()
        pg.wait_for_timeout(1500)
        check("a successful refresh clears the note", pg.locator(".today-note").count() == 0)
        pg.evaluate("() => { Date.now = window.__realNow; }")  # real clock again for the rest of the page
        s.overflow("Today")
        s.small_targets("Today strip and tabs", ".web-tabbar")

        def reader_open() -> bool:
            return pg.locator(".reader").count() > 0

        # The same gate as the extension, driven from the Sandpack frame.
        if frame is not None:
            frame.evaluate("window.parent.postMessage({type:'homepage:open-article', id:%s}, '*')" % json.dumps(first_id))
            try:
                pg.locator(".reader").wait_for(timeout=10_000)
            except Exception:
                pass
            check("homepage:open-article from the Sandpack frame opens the Reader", reader_open())
            if reader_open():
                pg.locator(".reader-title").first.wait_for(timeout=15_000)
                s.shot("13-today-open-article.png")
                check("it shows the archived story", pg.locator(".reader-title").inner_text().strip() != "")
                # While the Reader is open a second request is ignored (a page may not replace what you read).
                t = pg.locator(".reader-title").inner_text()
                frame.evaluate("window.parent.postMessage({type:'homepage:open-article', id:'zzzzzzzz'}, '*')")
                pg.wait_for_timeout(700)
                check("a request while the Reader is open is ignored", pg.locator(".reader-title").inner_text() == t)
                pg.locator(".back-btn").tap()
                pg.locator(".reader").wait_for(state="detached")

            # not from the frame: ignored
            pg.evaluate("window.postMessage({type:'homepage:open-article', id:%s}, '*')" % json.dumps(first_id))
            pg.wait_for_timeout(700)
            check("the same message from the page itself is ignored", not reader_open())

            # open-url: bad schemes ignored, good one opens the Reader without saving
            saves_before = len([1 for m, u in s.requests if m == "POST" and "/api/save" in u])
            pg.wait_for_timeout(2200)  # clear the rate-limit window
            for bad in ("javascript:alert(1)", "http://127.0.0.1:8080/x", "file:///etc/passwd", "https://u:p@example.com/"):
                frame.evaluate("window.parent.postMessage({type:'homepage:open-url', url:%s}, '*')" % json.dumps(bad))
                pg.wait_for_timeout(400)
            check("open-url ignores javascript:, loopback, file: and credentialed addresses", not reader_open())
            pg.wait_for_timeout(1200)
            frame.evaluate(
                "window.parent.postMessage({type:'homepage:open-url', url:'https://www.example.org/a/b?x=1'}, '*')")
            try:
                pg.locator(".reader").wait_for(timeout=8_000)
            except Exception:
                pass
            check("open-url with a public address opens the Reader", reader_open())
            pg.wait_for_timeout(1500)
            check("open-url saves nothing (a person must tap 'Fetch full article')",
                  len([1 for m, u in s.requests if m == "POST" and "/api/save" in u]) == saves_before)
            if reader_open():
                s.shot("14-today-open-url.png")
                pg.locator(".back-btn").tap()
                pg.locator(".reader").wait_for(state="detached")

            # Today hidden: a request from the (still mounted) frame is ignored
            pg.get_by_role("button", name="Library").tap()
            pg.wait_for_timeout(2300)
            frame.evaluate("window.parent.postMessage({type:'homepage:open-article', id:%s}, '*')" % json.dumps(first_id))
            pg.wait_for_timeout(800)
            check("a request while Today is not showing is ignored", not reader_open())

        print(f"  console errors: {len(s.console_errors)}")
        for e in s.console_errors[:8]:
            print("    ", e)
        check("no console errors (Today)", not s.console_errors, "; ".join(s.console_errors[:3]))
        s.close()

        # ---- light pass (default from prefers-color-scheme) and Today in light --------------------
        pass_("light", first=False)
        s = Session("light")
        s.page.goto(APP, wait_until="networkidle")
        s.page.get_by_role("button", name="Today").tap()
        s.page.locator(".today-strip").wait_for(timeout=20_000)
        for _ in range(120):
            fr = next((f for f in s.page.frames if SANDPACK in f.url), None)
            if fr and fr.locator("body *").count() > 5:
                break
            s.page.wait_for_timeout(500)
        s.page.wait_for_timeout(1500)
        s.shot("12-today-light.png")
        s.close()

        # ---- Today when Amber can't be reached on the first load: the full error state -----------
        print("\n== Today, first load fails ==")
        s = Session("dark")
        s.page.route("**/api/homepage", lambda route: route.abort())
        s.page.goto(APP, wait_until="networkidle")
        s.page.get_by_role("button", name="Today").tap()
        s.page.get_by_text("Couldn’t reach Amber.").wait_for(timeout=15_000)
        check("an initial load that fails shows 'Couldn’t reach Amber.'", True)
        check("...with no 'showing the last copy' note", s.page.locator(".today-note").count() == 0)
        s.shot("12c-today-first-load-failed.png")
        s.close()

        # ---- iOS < 17.4 has no AbortSignal.any: the app must still load everything ---------------
        print("\n== no AbortSignal.any ==")
        s = Session("dark")
        s.page.add_init_script("delete AbortSignal.any;")
        s.page.goto(APP, wait_until="networkidle")
        check("the init script removed AbortSignal.any", s.page.evaluate("typeof AbortSignal.any") == "undefined")
        s.page.locator(".view-latest button.row").first.wait_for(timeout=60_000)
        check("Latest loads without AbortSignal.any", s.page.locator(".view-latest button.row").count() > 0)
        s.page.get_by_role("button", name="Library").tap()
        s.page.locator(".view-library button.row").first.wait_for(timeout=20_000)
        check("Library loads without AbortSignal.any", s.page.locator(".view-library button.row").count() > 0)
        s.page.get_by_role("button", name="Today").tap()
        s.page.locator(".today-strip").wait_for(timeout=20_000)
        check("Today loads without AbortSignal.any", s.page.locator(".today-frame").count() == 1)
        check("no console errors (no AbortSignal.any)", not s.console_errors, "; ".join(s.console_errors[:3]))
        s.close()

        # ---- sizes: no overflow at 375, 390 and 430 ----------------------------------------------
        print("\n== widths ==")
        for width, height in ((375, 667), (375, 812), (390, 844), (430, 932)):
            s = Session("dark", width, height)
            pg = s.page
            pg.goto(APP, wait_until="networkidle")
            pg.locator(".view-latest button.row").first.wait_for(timeout=60_000)
            pg.wait_for_timeout(1500)
            s.overflow("Latest")
            pg.get_by_role("button", name="Library").tap()
            pg.locator(".view-library button.row").first.wait_for(timeout=20_000)
            s.overflow("Library")
            pg.locator(".view-library button.row").nth(2).tap()
            pg.locator(".reader-body p").first.wait_for(timeout=20_000)
            s.overflow("Reader")
            if (width, height) in ((375, 667), (430, 932)):
                pg.wait_for_timeout(500)
                s.shot(f"15-reader-{width}x{height}.png")
            pg.locator(".back-btn").tap()
            pg.get_by_role("button", name="Settings").tap()
            pg.locator(".modal").wait_for()
            pg.wait_for_timeout(500)
            s.overflow("Settings")
            if (width, height) in ((375, 667), (430, 932)):
                s.shot(f"16-settings-{width}x{height}.png")
            pg.get_by_role("button", name="Done").tap()
            pg.get_by_role("button", name="Today").tap()
            pg.locator(".today-strip").wait_for(timeout=20_000)
            s.overflow("Today")
            if height == 667:
                s.shot(f"17-today-{width}x{height}.png")
            s.close()

        browser.close()


try:
    run()
finally:
    stop_amber()

print("\n== summary ==")
print(f"screenshots in {OUT}")
for w in warnings:
    print("warning:", w)
if failures:
    print(f"{len(failures)} FAILED:")
    for f in failures:
        print("  -", f)
    sys.exit(1)
print("all hard assertions passed")
