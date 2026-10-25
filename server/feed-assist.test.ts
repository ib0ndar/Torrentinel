import { describe, expect, it } from "vitest";
import { FEED_ASSIST_CLOCK_SKEW_MS, FEED_ASSIST_MAX_AGE_MS, feedShowsNoChange, type FeedAssistInput } from "./feed-assist.js";

const now = Date.parse("2026-10-26T12:00:00Z");
const hoursAgo = (hours: number) => new Date(now - hours * 60 * 60 * 1_000).toISOString();
const magnet = (hash: string) => `magnet:?xt=urn:btih:${hash}&tr=http%3A%2F%2Fbt.t-ru.org%2Fann`;

/** A topic loaded an hour ago, a feed followed without a gap for the last day, and no feed entry for the topic. */
function settled(overrides: Partial<FeedAssistInput> = {}): FeedAssistInput {
  return {
    verifiedAt: hoursAgo(1),
    storedMagnet: magnet("ABC123"),
    continuousSince: hoursAgo(24),
    now,
    ...overrides,
  };
}

describe("feed-assisted direct checks", () => {
  it("skips the page of a topic the feed has not listed since it was loaded", () => {
    expect(feedShowsNoChange(settled())).toBe(true);
  });

  it("skips the page when the topic's feed entry is older than the page load and has the same torrent", () => {
    expect(feedShowsNoChange(settled({ entry: { publishedAt: hoursAgo(3), magnet: magnet("abc123") } }))).toBe(true);
  });

  it("loads a page that has never been loaded, or not within a day", () => {
    expect(feedShowsNoChange(settled({ verifiedAt: null }))).toBe(false);
    expect(feedShowsNoChange(settled({ verifiedAt: new Date(now - FEED_ASSIST_MAX_AGE_MS).toISOString() }))).toBe(false);
  });

  it("loads the page when the feed has had a gap since the page was loaded", () => {
    expect(feedShowsNoChange(settled({ continuousSince: undefined }))).toBe(false);
    expect(feedShowsNoChange(settled({ continuousSince: hoursAgo(0.5) }))).toBe(false);
    // Within the clock allowance of the page load, the tracker's clock may be behind.
    expect(feedShowsNoChange(settled({
      continuousSince: new Date(Date.parse(hoursAgo(1)) - FEED_ASSIST_CLOCK_SKEW_MS + 60_000).toISOString(),
    }))).toBe(false);
  });

  it("loads the page when the feed lists the topic as updated since it was loaded", () => {
    expect(feedShowsNoChange(settled({ entry: { publishedAt: hoursAgo(0.5), magnet: magnet("ABC123") } }))).toBe(false);
    expect(feedShowsNoChange(settled({
      entry: { publishedAt: new Date(Date.parse(hoursAgo(1)) - FEED_ASSIST_CLOCK_SKEW_MS + 60_000).toISOString() },
    }))).toBe(false);
  });

  it("loads the page when the feed lists a different torrent or no update time", () => {
    expect(feedShowsNoChange(settled({ entry: { publishedAt: hoursAgo(3), magnet: magnet("DEF456") } }))).toBe(false);
    expect(feedShowsNoChange(settled({ entry: { magnet: magnet("ABC123") } }))).toBe(false);
  });
});
