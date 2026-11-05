import { describe, expect, test } from "bun:test";
import type { FeedSource } from "@homepage/agent-core";
import { decideBootSources } from "../apps/web/src/boot-sources";

const ft = (enabled: boolean): FeedSource => ({
  id: "ft",
  name: "Financial Times",
  feedUrls: ["https://www.ft.com/rss/home"],
  enabled,
});
const wsj = (enabled: boolean): FeedSource => ({
  id: "wsj",
  name: "WSJ",
  feedUrls: ["https://feeds.content.dowjones.io/public/rss/RSSWSJD"],
  enabled,
});

describe("decideBootSources", () => {
  test("a newer Amber stamp replaces the local list", () => {
    expect(decideBootSources("t0", "t1", [ft(true)], [ft(false)])).toBe("adopt");
  });

  test("the first sync takes Amber's list", () => {
    expect(decideBootSources(null, "t1", null, [ft(true)])).toBe("adopt");
    expect(decideBootSources(null, "t1", [ft(false)], [ft(true)])).toBe("adopt");
  });

  test("a matching stamp with the same list is left alone", () => {
    expect(decideBootSources("t0", "t0", [ft(true), wsj(false)], [ft(true), wsj(false)])).toBe("keep");
  });

  test("a matching stamp with an unsent toggle is pushed", () => {
    expect(decideBootSources("t0", "t0", [ft(true), wsj(false)], [ft(false), wsj(false)])).toBe("push");
  });

  test("a matching stamp with a different feed address is pushed", () => {
    const local = [ft(true)];
    const remote = [{ ...ft(true), feedUrls: ["https://feeds.example/old"] }];
    expect(decideBootSources("t0", "t0", local, remote)).toBe("push");
  });

  test("nothing stored yet is adopted even when the stamp matches", () => {
    expect(decideBootSources("t0", "t0", null, [ft(true)])).toBe("adopt");
  });
});
