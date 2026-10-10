/**
 * Feed parsing, fetching and the bridge live in agent-core (they need only
 * `fetch` and `AbortSignal`, so the harness runs the same code). Re-exported here
 * so the extension imports them from one place.
 */
export {
  FEED_TIMEOUT_MS,
  canonicalLink,
  createFeedBridge,
  effectiveTime,
  fetchSourceFeeds,
  looksLikeFeed,
  mergeSourceFetches,
  parseFeed,
  probeFeed,
  type SourceFetch,
} from "@homepage/agent-core";
