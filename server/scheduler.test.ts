import { describe, expect, it, vi } from "vitest";
import {
  Scheduler,
  directSnapshotIsTemporarilyUnavailable,
  directSnapshotRequiresSilentSchemaUpgrade,
  previousDirectSnapshotLacksCoverObservation,
  previousDirectSnapshotWasTemporaryUnavailable,
  titleMatches,
} from "./scheduler.js";
import { createDatabase } from "./db.js";
import { SecretVault } from "./secrets.js";
import { escapeTelegram } from "./telegram.js";
import type { TelegramService } from "./telegram.js";
import type { DirectSnapshot } from "./types.js";
import { fingerprintRelease } from "./trackers/core/parsing.js";
import { trackerRegistry } from "./trackers/index.js";

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

describe("Kinozal search discovery migration", () => {
  it("silently seeds existing catalogue matches before notifying about later torrent IDs", async () => {
    const db = createDatabase(":memory:");
    const user = db.prepare("SELECT id FROM users WHERE username = 'admin'").get() as { id: string };
    const collection = db.prepare("SELECT id FROM collections WHERE user_id = ?").get(user.id) as { id: string };
    const timestamp = new Date().toISOString();
    db.prepare(`
      INSERT INTO subscriptions (
        id, user_id, collection_id, type, name, required_terms, ignored_terms,
        initialized, created_at, updated_at
      ) VALUES ('kinozal-rule', ?, ?, 'rule', '', ?, '[]', 1, ?, ?)
    `).run(user.id, collection.id, JSON.stringify(["Опасный", "2160p"]), timestamp, timestamp);
    db.prepare("INSERT INTO subscription_trackers (subscription_id, tracker_key) VALUES ('kinozal-rule', 'kinozal')").run();
    db.prepare(`
      INSERT INTO subscription_tracker_state (subscription_id, tracker_key, initialized)
      VALUES ('kinozal-rule', 'kinozal', 1)
    `).run();

    const existing = {
      trackerKey: "kinozal" as const,
      externalId: "2150115",
      title: "Особо ОПАСНЫЙ пассажир / Blu-Ray Remux (2160P)",
      url: "https://kinozal.me/details.php?id=2150115",
    };
    const later = {
      trackerKey: "kinozal" as const,
      externalId: "2150999",
      title: "Опасный рейс / WEB-DL (2160p)",
      url: "https://kinozal.me/details.php?id=2150999",
    };
    const plugin = trackerRegistry.get("kinozal");
    if (!plugin?.rules) throw new Error("Kinozal rule discovery is unavailable");
    const discover = vi.spyOn(plugin.rules, "discover")
      .mockResolvedValueOnce({ releases: [existing], coverage: { source: "search", complete: false } })
      .mockResolvedValueOnce({ releases: [existing, later], coverage: { source: "search", complete: false } });
    const notifyRelease = vi.fn(async () => undefined);
    const telegram = {
      canNotify: vi.fn(() => false),
      notifyRelease,
    } as unknown as TelegramService;
    const scheduler = new Scheduler(db, telegram, new SecretVault(Buffer.alloc(32, 9)));

    try {
      const baseline = await scheduler.run("test");
      expect(baseline.changed).toBe(0);
      expect(notifyRelease).not.toHaveBeenCalled();
      expect(db.prepare(`
        SELECT initialized, discovery_revision FROM subscription_tracker_state
        WHERE subscription_id = 'kinozal-rule' AND tracker_key = 'kinozal'
      `).get()).toEqual({ initialized: 1, discovery_revision: "kinozal-search-uploaded-v2" });
      expect(db.prepare("SELECT external_id FROM rule_matches WHERE subscription_id = 'kinozal-rule'").all())
        .toEqual([{ external_id: "2150115" }]);

      const update = await scheduler.run("test");
      expect(update.changed).toBe(1);
      expect(notifyRelease).toHaveBeenCalledTimes(1);
      expect(notifyRelease).toHaveBeenCalledWith(user.id, expect.objectContaining({
        release: expect.objectContaining({ externalId: "2150999" }),
      }));
      expect(db.prepare("SELECT COUNT(*) AS count FROM subscription_events WHERE subscription_id = 'kinozal-rule'").get())
        .toEqual({ count: 1 });
      expect(discover).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ userId: user.id, baseUrl: "https://kinozal.tv" }),
        { requiredTerms: ["Опасный", "2160p"] },
      );
    } finally {
      discover.mockRestore();
      db.close();
    }
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

describe("direct subscription title synchronization", () => {
  it("updates the display title on scheduled changes and repairs stale titles on manual checks", async () => {
    const db = createDatabase(":memory:");
    const user = db.prepare("SELECT id FROM users WHERE username = 'admin'").get() as { id: string };
    const collection = db.prepare("SELECT id FROM collections WHERE user_id = ?").get(user.id) as { id: string };
    const timestamp = new Date().toISOString();
    const previous: DirectSnapshot = {
      trackerKey: "rutor",
      externalId: "900001",
      title: "Series / Episodes 1-2 of 10",
      url: "https://rutor.is/torrent/900001/example",
      metadata: { snapshotVersion: 1, coverObserved: true },
      fingerprint: "previous-fingerprint",
    };
    const current: DirectSnapshot = {
      ...previous,
      title: "Series / Episodes 1-3 of 10",
      fingerprint: "current-fingerprint",
    };
    db.prepare(`
      INSERT INTO subscriptions (
        id, user_id, collection_id, type, name, direct_url, initialized,
        current_fingerprint, current_snapshot, created_at, updated_at
      ) VALUES (?, ?, ?, 'direct', ?, ?, 1, ?, ?, ?, ?)
    `).run(
      "900001", user.id, collection.id, previous.title, previous.url,
      previous.fingerprint, JSON.stringify(previous), timestamp, timestamp,
    );
    db.prepare("INSERT INTO subscription_trackers (subscription_id, tracker_key) VALUES (?, 'rutor')")
      .run("900001");

    const plugin = trackerRegistry.get("rutor");
    if (!plugin?.direct) throw new Error("Rutor direct monitor is unavailable");
    const fetchSnapshot = vi.spyOn(plugin.direct, "fetchSnapshot").mockResolvedValue(current);
    const notifyRelease = vi.fn(async () => undefined);
    const telegram = { notifyRelease } as unknown as TelegramService;
    const scheduler = new Scheduler(db, telegram, new SecretVault(Buffer.alloc(32, 7)));

    try {
      const scheduled = await scheduler.run("test");
      expect(scheduled.changed).toBe(1);
      expect(db.prepare("SELECT name FROM subscriptions WHERE id = '900001'").get())
        .toEqual({ name: current.title });
      const event = db.prepare("SELECT summary, payload FROM subscription_events WHERE subscription_id = '900001'")
        .get() as { summary: string; payload: string };
      expect(event.summary).toContain("title changed");
      expect(JSON.parse(event.payload)).toMatchObject({
        previous: { title: previous.title },
        current: { title: current.title },
      });
      expect(notifyRelease).toHaveBeenCalledTimes(1);

      db.prepare("UPDATE subscriptions SET name = ? WHERE id = '900001'").run(previous.title);
      await scheduler.checkSubscription("900001", user.id);
      expect(db.prepare("SELECT name FROM subscriptions WHERE id = '900001'").get())
        .toEqual({ name: current.title });
      expect(notifyRelease).toHaveBeenCalledTimes(1);
    } finally {
      fetchSnapshot.mockRestore();
      db.close();
    }
  });
});
