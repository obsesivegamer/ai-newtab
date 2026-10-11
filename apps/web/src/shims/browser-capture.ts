import type { FetchStage, FullArticleResult } from "@/lib/archive-save";

/**
 * "Capture with my browser" needs the extension's own signed-in browser windows, which a web
 * page doesn't have. The Reader never offers it in the web build (`IS_WEB`); this stub only keeps
 * the extension's `importFromBrowser` (and the tabs/scripting code under it) out of the bundle.
 */
export async function importFromBrowser(
  _base: string,
  _args: { url: string; title?: string },
  _opts: { signal?: AbortSignal; onStatus?: (stage: FetchStage) => void } = {},
): Promise<FullArticleResult> {
  return { ok: false, reason: "blocked" };
}
