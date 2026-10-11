import "./shims/browser";
import React from "react";
import ReactDOM from "react-dom/client";
import { KEYS } from "@/lib/storage";
import "@newtab/styles.css";
import "./web.css";
import { installFeedProxy } from "./feedProxy";
import { adoptRemoteSources, startSourceSync } from "./sync";
import WebApp from "./WebApp";

/** Dark unless the person chose otherwise or their device prefers light. */
function applyInitialTheme() {
  let theme: "dark" | "light" = "dark";
  try {
    const stored = localStorage.getItem("ui.theme");
    if (stored === "light" || stored === "dark") theme = stored;
    else if (window.matchMedia("(prefers-color-scheme: light)").matches) theme = "light";
  } catch {
    /* dark */
  }
  document.documentElement.dataset.theme = theme;
}

async function boot() {
  applyInitialTheme();
  installFeedProxy();
  // The archive is the Amber that served this page: there is no address to set.
  await browser.storage.local.set({ [KEYS.archiveUrl]: location.origin });
  // The sources list Amber holds (shared with the extension) wins; otherwise it is seeded from the archive.
  // Never holds the page up for long: same-origin, and given a few seconds at most. A failed or timed-out
  // read leaves the local list exactly as it was.
  await adoptRemoteSources(location.origin, AbortSignal.timeout(4_000)).catch(() => false);
  startSourceSync(location.origin);
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <WebApp />
    </React.StrictMode>,
  );
}

void boot();
