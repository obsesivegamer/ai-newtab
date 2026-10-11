import type { WebBrowser } from "./shims/browser";

declare global {
  /** Installed by `shims/browser.ts`, which `main.tsx` imports first. */
  const browser: WebBrowser;
}
