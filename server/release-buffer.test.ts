import { describe, expect, it } from "vitest";
import { createDatabase } from "./db.js";
import {
  bufferedReleases,
  feedHealth,
  ingestRollingFeedBatch,
  markFeedRecovery,
} from "./release-buffer.js";
import type { DiscoveryBatch } from "./trackers/core/contracts.js";

describe("rolling feed persistence", () => {
  it("buffers releases, measures overlap, and retains an unresolved gap until recovery", () => {
    const db = createDatabase(":memory:");
    try {
      const baseline = ingestRollingFeedBatch(db, "rutracker", batch(["1", "2", "3"]), "2026-08-31T10:05:00Z");
      expect(baseline).toMatchObject({
        entryCount: 3,
        newEntryCount: 3,
        coverageStatus: "baseline",
        gapDetected: false,
        bufferedCount: 3,
      });
      expect(baseline.overlapCount).toBeUndefined();

      const continuous = ingestRollingFeedBatch(db, "rutracker", batch(["2", "3", "4"]), "2026-08-31T10:15:00Z");
      expect(continuous).toMatchObject({
        overlapCount: 2,
        newEntryCount: 1,
        coverageStatus: "continuous",
        gapDetected: false,
        bufferedCount: 4,
      });

      const gap = ingestRollingFeedBatch(db, "rutracker", batch(["8", "9"]), "2026-08-31T12:05:00Z");
      expect(gap).toMatchObject({
        overlapCount: 0,
        newEntryCount: 2,
        coverageStatus: "gap",
        gapDetected: true,
        unresolvedGapSince: "2026-08-31T10:15:00Z",
        bufferedCount: 6,
      });
      expect(bufferedReleases(db, "rutracker").map((release) => release.externalId).sort())
        .toEqual(["1", "2", "3", "4", "8", "9"]);

      markFeedRecovery(db, "rutracker", true, "2026-08-31T12:06:00Z");
      expect(feedHealth(db, 30)[0]).toMatchObject({
        coverageStatus: "recovered",
        recoveredAt: "2026-08-31T12:06:00Z",
        pollingIntervalMinutes: 30,
      });
      expect(feedHealth(db, 30)[0].unresolvedGapSince).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("detects a gap hidden by a topic listed again with a new update time", () => {
    const db = createDatabase(":memory:");
    try {
      ingestRollingFeedBatch(db, "rutracker", batch(["1", "2", "3"]), "2026-08-31T10:05:00Z");
      // After an outage the feed holds only new topics and topic 2, updated again since.
      const afterOutage = ingestRollingFeedBatch(db, "rutracker", batch(["2", "8", "9"], { 2: "2026-08-31T13:00:00Z" }), "2026-08-31T13:05:00Z");
      expect(afterOutage).toMatchObject({ overlapCount: 0, newEntryCount: 3, gapDetected: true });
    } finally {
      db.close();
    }
  });

  it("tracks from when the feed has been followed without a gap", () => {
    const db = createDatabase(":memory:");
    try {
      expect(ingestRollingFeedBatch(db, "rutracker", batch(["1", "2"]), "2026-08-31T10:05:00Z").continuousSince)
        .toBe("2026-08-31T10:01:00.000Z");
      expect(ingestRollingFeedBatch(db, "rutracker", batch(["2", "3"]), "2026-08-31T10:10:00Z").continuousSince)
        .toBe("2026-08-31T10:01:00.000Z");
      // A gap restarts it at the oldest entry the new fetch could see.
      expect(ingestRollingFeedBatch(db, "rutracker", batch(["8", "9"]), "2026-08-31T12:00:00Z").continuousSince)
        .toBe("2026-08-31T10:08:00.000Z");
      // A recovery covers rules' search terms, not every topic, so it leaves the point where it was.
      markFeedRecovery(db, "rutracker", true, "2026-08-31T12:01:00Z");
      expect(ingestRollingFeedBatch(db, "rutracker", batch(["9", "10"]), "2026-08-31T12:05:00Z").continuousSince)
        .toBe("2026-08-31T10:08:00.000Z");
      // State saved before the column existed starts from the current fetch.
      db.prepare("UPDATE tracker_feed_state SET continuous_since = NULL").run();
      expect(ingestRollingFeedBatch(db, "rutracker", batch(["10", "11"]), "2026-08-31T12:10:00Z").continuousSince)
        .toBe("2026-08-31T10:10:00.000Z");
    } finally {
      db.close();
    }
  });

  it("compares entries saved before update times were kept by topic", () => {
    const db = createDatabase(":memory:");
    try {
      ingestRollingFeedBatch(db, "rutracker", batch(["1", "2", "3"]), "2026-08-31T10:05:00Z");
      db.prepare(`UPDATE tracker_feed_state SET previous_entry_ids = '["1","2","3"]'`).run();
      expect(ingestRollingFeedBatch(db, "rutracker", batch(["2", "3", "4"]), "2026-08-31T10:10:00Z"))
        .toMatchObject({ overlapCount: 2, gapDetected: false });
    } finally {
      db.close();
    }
  });
});

/** A feed fetch listing these topics. A topic keeps its update time until it is updated again (`updated`). */
function batch(ids: string[], updated: Record<string, string> = {}): DiscoveryBatch {
  const releases = ids.map((externalId) => ({
    trackerKey: "rutracker" as const,
    externalId,
    title: `Release ${externalId}`,
    url: `https://rutracker.org/forum/viewtopic.php?t=${externalId}`,
    publishedAt: updated[externalId] || new Date(Date.parse("2026-08-31T10:00:00Z") + Number(externalId) * 60_000).toISOString(),
  }));
  const times = releases.map((release) => release.publishedAt).sort();
  return {
    releases,
    coverage: { source: "feed", complete: false, oldestObservedAt: times[0] },
    cursor: times.at(-1),
  };
}
