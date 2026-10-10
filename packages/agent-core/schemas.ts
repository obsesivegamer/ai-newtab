/**
 * Input schemas for the custom tools. The caps live in the schema, not just
 * the handler, so the model can see the ceiling it is working against.
 */

/**
 * Structurally compatible with the SDK's `BetaManagedAgentsCustomToolInputSchema`,
 * which wants a mutable `required` and an open index signature.
 */
export interface ToolInputSchema {
  type: "object";
  properties: Record<string, unknown>;
  required: string[];
  [k: string]: unknown;
}

export const GET_HISTORY_SCHEMA: ToolInputSchema = {
  type: "object",
  properties: {
    daysToAnalyze: {
      type: "integer",
      minimum: 1,
      maximum: 90,
      description: "How many days of history to analyze. Default 14.",
    },
    maxResults: {
      type: "integer",
      minimum: 1,
      maximum: 50,
      description: "Top N domains by relevance score. Default 30.",
    },
  },
  required: [],
};

export const GET_PAGE_HTML_SCHEMA: ToolInputSchema = {
  type: "object",
  properties: {
    urls: {
      type: "array",
      minItems: 1,
      maxItems: 8,
      items: { type: "string" },
      description:
        "URLs to load in real browser tabs. Authenticated, JS-rendered pages work — " +
        "this is the user's own logged-in browser, not a fetch from a datacenter.",
    },
    loadDelayMs: {
      type: "integer",
      minimum: 0,
      maximum: 30000,
      description: "Extra wait after load, for lazy-rendered content. Default 8000.",
    },
  },
  required: ["urls"],
};

export const GET_ARCHIVE_SCHEMA: ToolInputSchema = {
  type: "object",
  properties: {
    sinceDays: {
      type: "integer",
      minimum: 1,
      maximum: 90,
      description: "How many days back to list saved articles. Default 30.",
    },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: 60,
      description: "Most recent N articles to return. Default 40.",
    },
  },
  required: [],
};

export const GET_ARCHIVE_ARTICLES_SCHEMA: ToolInputSchema = {
  type: "object",
  properties: {
    ids: {
      type: "array",
      minItems: 1,
      maxItems: 12,
      items: { type: "string" },
      description: "Article ids taken from getArchive. At most 12 per call.",
    },
  },
  required: ["ids"],
};

export const DEFAULTS = {
  daysToAnalyze: 14,
  maxResults: 30,
  loadDelayMs: 8000,
  archiveSinceDays: 30,
  archiveLimit: 40,
  /** Most article bodies mounted per getArchiveArticles call. */
  maxArchiveArticles: 12,
  /** Most article bodies mounted in one whole build. */
  maxArchiveMountsPerBuild: 24,
  /** Words kept from each mounted article; the native reader has the rest. */
  archiveWordLimit: 2000,
  /** Cap on titles carried per domain in the digest. */
  sampleTitles: 5,
} as const;
