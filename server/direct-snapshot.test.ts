import { describe, expect, it } from "vitest";
import { directBaselineOutcome, previousDirectSnapshotWasTemporaryUnavailable, previousDirectSnapshotLacksCoverObservation } from "./direct-snapshot.js";
import type { DirectSnapshot } from "./types.js";

const current: DirectSnapshot = {
  trackerKey: "rutor", externalId: "42", title: "Release", url: "https://rutor.is/torrent/42", fingerprint: "current",
  metadata: { coverObserved: true, snapshotVersion: 2 },
};
describe("direct snapshot classification", () => {
  it.each([
    [0, null, null, current, "baseline"],
    [1, "old", "{}", { ...current, metadata: { feedSeen: false } }, "temporarily-unavailable"],
    [1, "old", '{"metadata":{"feedSeen":false}}', current, "rebaseline"],
    [1, "old", "{}", current, "cover-backfill"],
    [1, "old", '{"metadata":{"coverObserved":true,"snapshotVersion":1}}', current, "schema-upgrade"],
    [1, "old", JSON.stringify(current), current, undefined],
  ] as const)("preserves the baseline decision order", (initialized, fingerprint, previous, snapshot, outcome) => {
    expect(directBaselineOutcome(initialized, fingerprint, previous, snapshot)).toBe(outcome);
  });
  it.each(["null", "[]", "42", '"string"', "not-json", '{"metadata":null}'])("handles malformed or non-object stored snapshots: %s", (value) => {
    expect(previousDirectSnapshotWasTemporaryUnavailable(value)).toBe(false);
    expect(previousDirectSnapshotLacksCoverObservation(value)).toBe(true);
    expect(directBaselineOutcome(1, "old", value, current)).toBe("cover-backfill");
  });
});
