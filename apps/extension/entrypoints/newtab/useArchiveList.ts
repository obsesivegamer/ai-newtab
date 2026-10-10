import { useCallback, useEffect, useState } from "react";
import type { ArchiveArticleMeta, GetArchiveResult } from "@homepage/agent-core";
import { createArchiveBridge } from "@/lib/archive";

export const LIBRARY_DAYS = 90;
export const LIBRARY_LIMIT = 200;

export type ArchiveListState =
  | { status: "loading" }
  | { status: "off" }
  | { status: "error"; kind: "down" | "no-api" | "other"; detail: string }
  | {
      status: "ready";
      articles: ArchiveArticleMeta[];
      sources: GetArchiveResult["sources"];
      totalUsable: number;
    };

/** Turn a thrown fetch/HTTP error into the three situations the UI tells apart. */
export function classifyArchiveError(err: unknown): { kind: "down" | "no-api" | "other"; detail: string } {
  const message = err instanceof Error ? err.message : String(err);
  const http = /responded (\d+)/.exec(message);
  if (http) {
    return http[1] === "404"
      ? { kind: "no-api", detail: message }
      : { kind: "other", detail: `Amber answered with an error (${http[1]}).` };
  }
  return { kind: "down", detail: message };
}

/**
 * The Library's data: the last 90 days of the archive, newest first.
 * `archiveUrl` is null until settings have loaded, and "" when the archive is off.
 */
export function useArchiveList(archiveUrl: string | null) {
  const [state, setState] = useState<ArchiveListState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (archiveUrl === null) return;
    if (archiveUrl.trim() === "") {
      setState({ status: "off" });
      return;
    }
    let cancelled = false;
    setState({ status: "loading" });
    createArchiveBridge(archiveUrl)
      .listArticles({ sinceDays: LIBRARY_DAYS, limit: LIBRARY_LIMIT })
      .then((result) => {
        if (cancelled) return;
        const articles = [...result.articles].sort((a, b) => b.savedAt.localeCompare(a.savedAt));
        setState({ status: "ready", articles, sources: result.sources, totalUsable: result.totalUsable });
      })
      .catch((err) => {
        if (!cancelled) setState({ status: "error", ...classifyArchiveError(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [archiveUrl, attempt]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  return { state, reload };
}
