import { describe, expect, it } from "vitest";
import {
  directSnapshotIsTemporarilyUnavailable,
  directSnapshotRequiresSilentSchemaUpgrade,
  previousDirectSnapshotLacksCoverObservation,
  previousDirectSnapshotWasTemporaryUnavailable,
  titleMatches,
} from "./scheduler.js";
import { escapeTelegram } from "./telegram.js";
import { fingerprintRelease } from "./trackers/core/parsing.js";

describe("rule matching", () => {
  it("requires every required phrase without case sensitivity", () => {
    expect(titleMatches("The SHOW — Season 02 — 2160P", ["show", "2160p"], [])).toBe(true);
    expect(titleMatches("The Show — Season 02", ["show", "2160p"], [])).toBe(false);
  });

  it("rejects a title containing any ignored phrase", () => {
    expect(titleMatches("The Show 2160p Trailer", ["show", "2160p"], ["trailer", "teaser"])).toBe(false);
    expect(titleMatches("Сериал WEB-DL", ["сериал", "web-dl"], ["трейлер"])).toBe(true);
  });
});

describe("change and notification helpers", () => {
  it("changes the fingerprint when monitored release fields change", () => {
    const release = { trackerKey: "rutor" as const, externalId: "1", title: "One", url: "https://rutor.is/torrent/1" };
    expect(fingerprintRelease(release)).not.toBe(fingerprintRelease({ ...release, title: "Two" }));
  });

  it("escapes Telegram HTML", () => {
    expect(escapeTelegram("A < B & C > D")).toBe("A &lt; B &amp; C &gt; D");
  });

  it("treats a missing rolling-feed topic as no observation", () => {
    expect(directSnapshotIsTemporarilyUnavailable({
      trackerKey: "rutracker",
      externalId: "88",
      title: "RuTracker topic #88",
      url: "https://rutracker.org/forum/viewtopic.php?t=88",
      metadata: { feedSeen: false },
      fingerprint: "placeholder",
    })).toBe(true);
  });

  it("recognizes old feed placeholders for a silent detail-page rebaseline", () => {
    expect(previousDirectSnapshotWasTemporaryUnavailable(JSON.stringify({
      title: "RuTracker topic #88",
      metadata: { feedSeen: false },
    }))).toBe(true);
    expect(previousDirectSnapshotWasTemporaryUnavailable(JSON.stringify({
      title: "Actual title",
      metadata: { detailSource: "browser-session" },
    }))).toBe(false);
    expect(previousDirectSnapshotWasTemporaryUnavailable("not-json")).toBe(false);
  });

  it("recognizes pre-cover snapshots for a silent artwork baseline", () => {
    expect(previousDirectSnapshotLacksCoverObservation(JSON.stringify({
      title: "Existing release",
      metadata: { detailSource: "browser-session" },
    }))).toBe(true);
    expect(previousDirectSnapshotLacksCoverObservation(JSON.stringify({
      title: "Cover-aware release",
      metadata: { coverObserved: true },
    }))).toBe(false);
  });

  it("silently migrates direct snapshots to a new plugin schema", () => {
    const current = {
      trackerKey: "rutor" as const,
      externalId: "88",
      title: "Release",
      url: "https://rutor.is/torrent/88",
      metadata: { snapshotVersion: 1, coverObserved: true },
      fingerprint: "current",
    };
    expect(directSnapshotRequiresSilentSchemaUpgrade(JSON.stringify({ metadata: { coverObserved: true } }), current)).toBe(true);
    expect(directSnapshotRequiresSilentSchemaUpgrade(JSON.stringify({ metadata: { snapshotVersion: 1 } }), current)).toBe(false);
  });
});
