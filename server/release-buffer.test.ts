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
      const baseline = ingestRollingFeedBatch(db, "rutracker", batch(["1", "2", "3"], "2026-08-31T10:00:00Z"), "2026-08-31T10:05:00Z");
      expect(baseline).toMatchObject({
        entryCount: 3,
        newEntryCount: 3,
        coverageStatus: "baseline",
        gapDetected: false,
        bufferedCount: 3,
      });
      expect(baseline.overlapCount).toBeUndefined();

      const continuous = ingestRollingFeedBatch(db, "rutracker", batch(["2", "3", "4"], "2026-08-31T10:10:00Z"), "2026-08-31T10:15:00Z");
      expect(continuous).toMatchObject({
        overlapCount: 2,
        newEntryCount: 1,
        coverageStatus: "continuous",
        gapDetected: false,
        bufferedCount: 4,
      });

      const gap = ingestRollingFeedBatch(db, "rutracker", batch(["8", "9"], "2026-08-31T12:00:00Z"), "2026-08-31T12:05:00Z");
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
});

function batch(ids: string[], start: string): DiscoveryBatch {
  const startMs = Date.parse(start);
  const releases = ids.map((externalId, index) => ({
    trackerKey: "rutracker" as const,
    externalId,
    title: `Release ${externalId}`,
    url: `https://rutracker.org/forum/viewtopic.php?t=${externalId}`,
    publishedAt: new Date(startMs + index * 60_000).toISOString(),
  }));
  return {
    releases,
    coverage: { source: "feed", complete: false, oldestObservedAt: releases[0]?.publishedAt },
    cursor: releases.at(-1)?.publishedAt,
  };
}
