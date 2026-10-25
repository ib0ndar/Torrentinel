import { readFileSync } from "node:fs";
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
import type { DirectSnapshot, Release } from "./types.js";
import { fingerprintRelease } from "./trackers/core/parsing.js";
import { trackerRegistry } from "./trackers/index.js";
import type { DiscoveryBatch } from "./trackers/core/contracts.js";
import type { CoverCacheStore } from "./cover-cache.js";
import { ReleaseBufferView } from "./release-buffer.js";
import { TrackerError } from "./trackers/core/errors.js";

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
    const notifyRelease = vi.fn(async () => ({ delivered: true }));
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

describe("rule enrichment reuse", () => {
  it.each([
    { name: "overlapping rules", separateUsers: false, failFirst: false, expectedFetches: 1 },
    { name: "different users", separateUsers: true, failFirst: false, expectedFetches: 2 },
    { name: "failed detail fetches", separateUsers: false, failFirst: true, expectedFetches: 2 },
  ])("reuses only successful, user-scoped details for $name", async ({ separateUsers, failFirst, expectedFetches }) => {
    const db = createDatabase(":memory:");
    const user = db.prepare("SELECT id FROM users WHERE username = 'admin'").get() as { id: string };
    const collection = db.prepare("SELECT id FROM collections WHERE user_id = ?").get(user.id) as { id: string };
    const timestamp = new Date().toISOString();
    if (separateUsers) {
      db.prepare(`
        INSERT INTO users (id, username, password_hash, created_at, updated_at)
        SELECT 'other-user', 'other', password_hash, created_at, updated_at FROM users WHERE id = ?
      `).run(user.id);
      db.prepare(`
        INSERT INTO collections (id, user_id, name, created_at, updated_at)
        VALUES ('other-collection', 'other-user', 'Inbox', ?, ?)
      `).run(timestamp, timestamp);
    }
    for (let index = 0; index < 2; index += 1) {
      const otherUser = separateUsers && index === 1;
      db.prepare(`
        INSERT INTO subscriptions (id, user_id, collection_id, type, name, required_terms, created_at, updated_at)
        VALUES (?, ?, ?, 'rule', '', ?, ?, ?)
      `).run(`rule-${index}`, otherUser ? "other-user" : user.id,
        otherUser ? "other-collection" : collection.id, JSON.stringify([index ? "release" : "needle"]), timestamp, timestamp);
      db.prepare("INSERT INTO subscription_trackers (subscription_id, tracker_key) VALUES (?, 'kinozal')")
        .run(`rule-${index}`);
    }
    const plugin = trackerRegistry.get("kinozal");
    if (!plugin?.rules || !plugin.direct) throw new Error("Kinozal monitor is unavailable");
    const discover = vi.spyOn(plugin.rules, "discover")
      .mockResolvedValue({ releases: [], coverage: { source: "search", complete: false } });
    const snapshot: DirectSnapshot = {
      trackerKey: "kinozal", externalId: "42", title: "Needle release", fingerprint: "details",
      url: "https://kinozal.tv/details.php?id=42", magnet: "magnet:?xt=urn:btih:test",
    };
    const fetchSnapshot = vi.spyOn(plugin.direct, "fetchSnapshot").mockResolvedValue(snapshot);
    if (failFirst) fetchSnapshot.mockRejectedValueOnce(new Error("temporary detail failure"));
    const notifyRelease = vi.fn<TelegramService["notifyRelease"]>(async () => ({ delivered: true }));
    const telegram = { canNotify: () => true, notifyRelease } as unknown as TelegramService;
    const scheduler = new Scheduler(db, telegram, new SecretVault(Buffer.alloc(32, 7)));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect((await scheduler.run("test")).changed).toBe(0);
      expect(fetchSnapshot).not.toHaveBeenCalled();
      discover.mockResolvedValue({
        releases: [{ ...snapshot, magnet: undefined }], coverage: { source: "search", complete: false },
      });
      expect((await scheduler.run("test")).changed).toBe(2);
      expect(fetchSnapshot).toHaveBeenCalledTimes(expectedFetches);
      expect(notifyRelease).toHaveBeenCalledTimes(2);
      expect(db.prepare("SELECT COUNT(*) AS count FROM rule_matches").get()).toEqual({ count: 2 });
      const observations = db.prepare(`
        SELECT outcome, details FROM tracker_observations WHERE operation = 'rule-enrichment' ORDER BY rowid
      `).all() as Array<{ outcome: string; details: string }>;
      expect(observations).toHaveLength(2);
      if (!separateUsers && !failFirst) {
        expect(observations.map((row) => JSON.parse(row.details).cacheHit)).toEqual([false, true]);
        expect(notifyRelease.mock.calls).toEqual([
          [user.id, expect.objectContaining({ subscriptionId: "rule-0", release: snapshot })],
          [user.id, expect.objectContaining({ subscriptionId: "rule-1", release: snapshot })],
        ]);
      }
      if (separateUsers) {
        expect(new Set(fetchSnapshot.mock.calls.map(([, context]) => context.userId))).toEqual(new Set([user.id, "other-user"]));
        expect(observations.every((row) => JSON.parse(row.details).cacheHit === false)).toBe(true);
      }
      if (failFirst) expect(observations.map((row) => row.outcome)).toEqual(["error", "enriched"]);
      expect((await scheduler.run("test")).changed).toBe(0);
      expect(fetchSnapshot).toHaveBeenCalledTimes(expectedFetches);
      expect(notifyRelease).toHaveBeenCalledTimes(2);

      // An existing rule with an empty baseline sees this release in a later run.
      // Its enrichment must not reuse the previous run's cached snapshot.
      db.prepare(`
        INSERT INTO subscriptions (id, user_id, collection_id, type, name, required_terms, created_at, updated_at)
        VALUES ('later-rule', ?, ?, 'rule', '', '["needle"]', ?, ?)
      `).run(user.id, collection.id, timestamp, timestamp);
      db.prepare("INSERT INTO subscription_trackers (subscription_id, tracker_key) VALUES ('later-rule', 'kinozal')").run();
      discover.mockResolvedValue({ releases: [], coverage: { source: "search", complete: false } });
      await scheduler.run("test");
      const freshSnapshot = { ...snapshot, title: "Needle release with fresh details" };
      discover.mockResolvedValue({
        releases: [{ ...snapshot, magnet: undefined }], coverage: { source: "search", complete: false },
      });
      fetchSnapshot.mockResolvedValue(freshSnapshot);
      expect((await scheduler.run("test")).changed).toBe(1);
      expect(fetchSnapshot).toHaveBeenCalledTimes(expectedFetches + 1);
      expect(notifyRelease).toHaveBeenLastCalledWith(user.id, expect.objectContaining({
        subscriptionId: "later-rule", release: freshSnapshot,
      }));
    } finally {
      discover.mockRestore();
      fetchSnapshot.mockRestore();
      warning.mockRestore();
      db.close();
    }
  });
});

describe("RuTracker feed continuity", () => {
  it("records one feed poll and distinct rule evaluations when a batch is shared", async () => {
    const db = createDatabase(":memory:");
    const user = db.prepare("SELECT id FROM users WHERE username = 'admin'").get() as { id: string };
    const collection = db.prepare("SELECT id FROM collections WHERE user_id = ?").get(user.id) as { id: string };
    const timestamp = new Date().toISOString();
    const insertRule = db.prepare(`
      INSERT INTO subscriptions (
        id, user_id, collection_id, type, name, required_terms, ignored_terms,
        created_at, updated_at
      ) VALUES (?, ?, ?, 'rule', '', ?, '[]', ?, ?)
    `);
    insertRule.run("rutracker-rule-one", user.id, collection.id, JSON.stringify(["needle"]), timestamp, timestamp);
    insertRule.run("rutracker-rule-two", user.id, collection.id, JSON.stringify(["haystack"]), timestamp, timestamp);
    db.prepare("INSERT INTO subscription_trackers (subscription_id, tracker_key) VALUES (?, 'rutracker')")
      .run("rutracker-rule-one");
    db.prepare("INSERT INTO subscription_trackers (subscription_id, tracker_key) VALUES (?, 'rutracker')")
      .run("rutracker-rule-two");

    const plugin = trackerRegistry.get("rutracker");
    if (!plugin?.rules) throw new Error("RuTracker rule discovery is unavailable");
    const discover = vi.spyOn(plugin.rules, "discover")
      .mockResolvedValue(feedBatch([release("1"), release("2")], "2026-08-31T10:00:00Z"));
    const telegram = {
      canNotify: vi.fn(() => false),
      notifyRelease: vi.fn(async () => ({ delivered: true })),
    } as unknown as TelegramService;
    const scheduler = new Scheduler(db, telegram, new SecretVault(Buffer.alloc(32, 6)));

    try {
      await scheduler.run("test");
      expect(discover).toHaveBeenCalledTimes(1);
      const observations = db.prepare(`
        SELECT operation, outcome, details FROM tracker_observations
        WHERE tracker_key = 'rutracker' ORDER BY rowid
      `).all() as Array<{ operation: string; outcome: string; details: string }>;
      const feedPolls = observations.filter((row) => row.operation === "feed-poll");
      const ruleEvaluations = observations.filter((row) => row.operation === "rule-discovery");
      expect(feedPolls).toHaveLength(1);
      expect(feedPolls[0].outcome).toBe("baseline");
      expect(JSON.parse(feedPolls[0].details)).toMatchObject({
        feedEntryCount: 2,
        feedNewEntryCount: 2,
        feedOverlapCount: null,
        feedCoverageStatus: "baseline",
      });
      expect(ruleEvaluations).toHaveLength(2);
      expect(ruleEvaluations.map((row) => JSON.parse(row.details).requiredTerms)).toEqual(["needle", "haystack"]);
      expect(ruleEvaluations.every((row) => !("feedEntryCount" in JSON.parse(row.details)))).toBe(true);
    } finally {
      discover.mockRestore();
      db.close();
    }
  });

  it("reads the release buffer once per poll and prepares each mirror's copy once", async () => {
    const db = createDatabase(":memory:");
    const admin = db.prepare("SELECT id FROM users WHERE username = 'admin'").get() as { id: string };
    const timestamp = new Date().toISOString();
    db.prepare(`INSERT INTO users (id, username, password_hash, created_at, updated_at)
      VALUES ('second', 'second', 'x', ?, ?)`).run(timestamp, timestamp);
    db.prepare("INSERT INTO collections (id, user_id, name, created_at, updated_at) VALUES ('second-collection', 'second', 'Main', ?, ?)")
      .run(timestamp, timestamp);
    const adminCollection = (db.prepare("SELECT id FROM collections WHERE user_id = ?").get(admin.id) as { id: string }).id;
    for (const [id, userId, collectionId, term] of [
      ["admin-needle", admin.id, adminCollection, "needle"],
      ["admin-release", admin.id, adminCollection, "release"],
      ["second-needle", "second", "second-collection", "needle"],
      ["second-release", "second", "second-collection", "release"],
    ]) {
      db.prepare(`INSERT INTO subscriptions (id, user_id, collection_id, type, name, required_terms, created_at, updated_at)
        VALUES (?, ?, ?, 'rule', '', ?, ?, ?)`).run(id, userId, collectionId, JSON.stringify([term]), timestamp, timestamp);
      db.prepare("INSERT INTO subscription_trackers (subscription_id, tracker_key) VALUES (?, 'rutracker')").run(id);
    }
    const plugin = trackerRegistry.get("rutracker");
    if (!plugin?.rules) throw new Error("RuTracker rule discovery is unavailable");
    const discover = vi.spyOn(plugin.rules, "discover").mockResolvedValue(feedBatch([release("1"), release("2")], "2026-08-31T10:00:00Z"));
    const reload = vi.spyOn(ReleaseBufferView.prototype, "reload");
    const normalizeUrl = vi.spyOn(plugin, "normalizeUrl");
    const telegram = { canNotify: vi.fn(() => false), notifyRelease: vi.fn() } as unknown as TelegramService;
    const scheduler = new Scheduler(db, telegram, new SecretVault(Buffer.alloc(32, 7)));
    try {
      const status = await scheduler.run("test");
      expect(status).toMatchObject({ checked: 2, errors: 0 });
      expect(discover).toHaveBeenCalledTimes(1);
      expect(reload).toHaveBeenCalledTimes(1);
      // Two releases moved onto the one mirror both users share, not once for each of the four rule groups.
      expect(normalizeUrl).toHaveBeenCalledTimes(2);
      expect(db.prepare("SELECT COUNT(*) AS count FROM rule_matches").get()).toEqual({ count: 8 });
    } finally {
      discover.mockRestore();
      reload.mockRestore();
      normalizeUrl.mockRestore();
      db.close();
    }
  });

  it("requests a failed feed once per poll and reports the failure on every rule", async () => {
    const db = createDatabase(":memory:");
    const user = db.prepare("SELECT id FROM users WHERE username = 'admin'").get() as { id: string };
    const collection = db.prepare("SELECT id FROM collections WHERE user_id = ?").get(user.id) as { id: string };
    const timestamp = new Date().toISOString();
    for (const [id, term] of [["needle", "needle"], ["haystack", "haystack"]]) {
      db.prepare(`INSERT INTO subscriptions (id, user_id, collection_id, type, name, required_terms, created_at, updated_at)
        VALUES (?, ?, ?, 'rule', '', ?, ?, ?)`).run(id, user.id, collection.id, JSON.stringify([term]), timestamp, timestamp);
      db.prepare("INSERT INTO subscription_trackers (subscription_id, tracker_key) VALUES (?, 'rutracker')").run(id);
    }
    const plugin = trackerRegistry.get("rutracker");
    if (!plugin?.rules) throw new Error("RuTracker rule discovery is unavailable");
    const discover = vi.spyOn(plugin.rules, "discover")
      .mockRejectedValue(new TrackerError("network", "Request to feed.rutracker.cc failed", { trackerKey: "rutracker" }));
    const telegram = { canNotify: vi.fn(() => false), notifyRelease: vi.fn() } as unknown as TelegramService;
    const scheduler = new Scheduler(db, telegram, new SecretVault(Buffer.alloc(32, 8)));
    try {
      const status = await scheduler.run("test");
      expect(discover).toHaveBeenCalledTimes(1);
      expect(status).toMatchObject({ checked: 0, errors: 1 });
      expect(db.prepare("SELECT operation, outcome FROM tracker_observations ORDER BY rowid").all()).toEqual([
        { operation: "feed-poll", outcome: "network" },
        { operation: "rule-discovery", outcome: "network" },
        { operation: "rule-discovery", outcome: "network" },
      ]);
      expect(db.prepare("SELECT last_error FROM subscriptions ORDER BY id").all()).toEqual([
        { last_error: "rutracker: Request to feed.rutracker.cc failed" },
        { last_error: "rutracker: Request to feed.rutracker.cc failed" },
      ]);
    } finally {
      discover.mockRestore();
      db.close();
    }
  });

  it("recovers a non-overlapping feed window and processes buffered matches", async () => {
    const db = createDatabase(":memory:");
    const user = db.prepare("SELECT id FROM users WHERE username = 'admin'").get() as { id: string };
    const collection = db.prepare("SELECT id FROM collections WHERE user_id = ?").get(user.id) as { id: string };
    const timestamp = new Date().toISOString();
    db.prepare(`
      INSERT INTO subscriptions (
        id, user_id, collection_id, type, name, required_terms, ignored_terms,
        created_at, updated_at
      ) VALUES ('rutracker-rule', ?, ?, 'rule', '', ?, '[]', ?, ?)
    `).run(user.id, collection.id, JSON.stringify(["needle"]), timestamp, timestamp);
    db.prepare("INSERT INTO subscription_trackers (subscription_id, tracker_key) VALUES ('rutracker-rule', 'rutracker')").run();

    const first = [release("1"), release("2")];
    const next = [release("3"), release("4")];
    const recovered = release("5");
    const plugin = trackerRegistry.get("rutracker");
    if (!plugin?.rules?.recover) throw new Error("RuTracker recovery is unavailable");
    const discover = vi.spyOn(plugin.rules, "discover")
      .mockResolvedValueOnce(feedBatch(first, "2026-08-31T10:00:00Z"))
      .mockResolvedValueOnce(feedBatch(next, "2026-08-31T12:00:00Z"));
    const recover = vi.spyOn(plugin.rules, "recover").mockResolvedValue({
      releases: [recovered],
      coverage: { source: "search", complete: true, oldestObservedAt: "2026-08-31T10:30:00Z" },
      cursor: "2026-08-31T10:30:00Z",
      sourceUrl: "https://rutracker.org/forum/tracker.php?nm=needle&o=1&s=2",
    });
    const notifyRelease = vi.fn(async () => ({ delivered: true }));
    const telegram = {
      canNotify: vi.fn(() => false),
      notifyRelease,
    } as unknown as TelegramService;
    const scheduler = new Scheduler(db, telegram, new SecretVault(Buffer.alloc(32, 4)));

    try {
      expect((await scheduler.run("test")).changed).toBe(0);
      expect((await scheduler.run("test")).changed).toBe(1);
      expect(recover).toHaveBeenCalledWith(
        expect.objectContaining({ userId: user.id, baseUrl: "https://rutracker.org" }),
        { requiredTerms: ["needle"] },
        expect.any(String),
      );
      expect(notifyRelease).toHaveBeenCalledTimes(3);
      expect(db.prepare(`
        SELECT external_id FROM rule_matches WHERE subscription_id = 'rutracker-rule' ORDER BY external_id
      `).all()).toEqual(["1", "2", "3", "4", "5"].map((external_id) => ({ external_id })));
      expect(scheduler.discoveryHealth()[0]).toMatchObject({
        trackerKey: "rutracker",
        coverageStatus: "recovered",
        unresolvedGapSince: undefined,
      });
      const observations = db.prepare(`
        SELECT operation, outcome, details FROM tracker_observations
        WHERE tracker_key = 'rutracker' ORDER BY rowid
      `).all() as Array<{ operation: string; outcome: string; details: string }>;
      const feedPolls = observations.filter((row) => row.operation === "feed-poll");
      expect(feedPolls).toHaveLength(2);
      expect(feedPolls.map((row) => row.outcome)).toEqual(["baseline", "coverage-gap"]);
      expect(JSON.parse(feedPolls[0].details)).toMatchObject({
        feedNewEntryCount: 2,
        feedOverlapCount: null,
        feedCoverageStatus: "baseline",
      });
      expect(JSON.parse(feedPolls[1].details)).toMatchObject({
        feedNewEntryCount: 2,
        feedOverlapCount: 0,
        feedCoverageStatus: "gap",
      });
      const latestRule = observations.filter((row) => row.operation === "rule-discovery").at(-1)!;
      expect(latestRule.outcome).toBe("new-matches");
      expect(JSON.parse(latestRule.details)).toMatchObject({
        requiredTerms: "needle",
        recoveryCount: 1,
        recoveryComplete: true,
      });
      expect(JSON.parse(latestRule.details)).not.toHaveProperty("feedEntryCount");
    } finally {
      discover.mockRestore();
      recover.mockRestore();
      db.close();
    }
  });
});

describe("change and notification helpers", () => {
  it("changes the fingerprint when monitored release fields change", () => {
    const release = { trackerKey: "rutor" as const, externalId: "1", title: "One", url: "https://rutor.is/torrent/1" };
    expect(fingerprintRelease(release)).not.toBe(fingerprintRelease({ ...release, title: "Two" }));
  });

  it("keeps the fingerprint when only the mirror changes", () => {
    const onMirror = (origin: string) => ({
      trackerKey: "kinozal" as const,
      externalId: "71",
      title: "Release",
      url: `${origin}/details.php?id=71`,
      coverUrl: `${origin}/i/poster/71.jpg`,
      torrentUrl: `${origin}/download.php?id=71`,
    });
    expect(fingerprintRelease(onMirror("https://kinozal.guru"))).toBe(fingerprintRelease(onMirror("http://kinozal.me")));
    expect(fingerprintRelease(onMirror("https://kinozal.guru"))).not.toBe(fingerprintRelease({
      ...onMirror("https://kinozal.guru"),
      coverUrl: "https://kinozal.guru/i/poster/72.jpg",
    }));
    // Links on another host stay whole, including a fixed download host that looks like a subdomain.
    const offSite = { ...onMirror("https://kinozal.guru"), coverUrl: "https://images.example/71.jpg" };
    expect(fingerprintRelease(offSite)).not.toBe(fingerprintRelease({ ...offSite, coverUrl: "https://other.example/71.jpg" }));
    const download = (origin: string) => ({ ...onMirror(origin), torrentUrl: "https://dl.kinozal.guru/download.php?id=71" });
    expect(fingerprintRelease(download("https://kinozal.guru"))).toBe(fingerprintRelease(download("https://kinozal.me")));
  });

  it("does not report a change when only the mirror is switched, and moves stored links to the new mirror", async () => {
    const db = createDatabase(":memory:");
    const user = db.prepare("SELECT id FROM users WHERE username = 'admin'").get() as { id: string };
    const collection = db.prepare("SELECT id FROM collections WHERE user_id = ?").get(user.id) as { id: string };
    const timestamp = new Date().toISOString();
    db.prepare(`
      INSERT INTO subscriptions (id, user_id, collection_id, type, name, direct_url, created_at, updated_at)
      VALUES ('direct', ?, ?, 'direct', '', 'https://rutor.is/torrent/472', ?, ?)
    `).run(user.id, collection.id, timestamp, timestamp);
    db.prepare("INSERT INTO subscription_trackers (subscription_id, tracker_key) VALUES ('direct', 'rutor')").run();
    const page = readFileSync(new URL("./trackers/plugins/rutor/fixtures/direct.html", import.meta.url), "utf8");
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => (
      new Response(page, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } })
    ));
    const telegram = { canNotify: () => false, notifyRelease: vi.fn() } as unknown as TelegramService;
    const scheduler = new Scheduler(db, telegram, new SecretVault(Buffer.alloc(32, 9)));
    try {
      await scheduler.run("baseline");
      db.prepare("UPDATE tracker_mirrors SET base_url = 'https://rutor.info' WHERE tracker_key = 'rutor'").run();
      await scheduler.run("mirror switched");
      expect(db.prepare("SELECT COUNT(*) AS count FROM subscription_events").get()).toEqual({ count: 0 });
      const stored = db.prepare("SELECT current_snapshot FROM subscriptions WHERE id = 'direct'").get() as { current_snapshot: string };
      expect(JSON.parse(stored.current_snapshot).url).toBe("https://rutor.info/torrent/472");
    } finally {
      fetch.mockRestore();
      db.close();
    }
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
  it("caches the baseline cover and retries refreshes after an update-time failure", async () => {
    const db = createDatabase(":memory:");
    const user = db.prepare("SELECT id FROM users WHERE username = 'admin'").get() as { id: string };
    const collection = db.prepare("SELECT id FROM collections WHERE user_id = ?").get(user.id) as { id: string };
    const timestamp = new Date().toISOString();
    db.prepare(`
      INSERT INTO subscriptions (
        id, user_id, collection_id, type, name, direct_url, created_at, updated_at
      ) VALUES ('cover-retry', ?, ?, 'direct', '', 'https://rutor.is/torrent/800/test', ?, ?)
    `).run(user.id, collection.id, timestamp, timestamp);
    db.prepare("INSERT INTO subscription_trackers (subscription_id, tracker_key) VALUES ('cover-retry', 'rutor')").run();

    const baseline = directSnapshot("Baseline", "fingerprint-1", "cover-1.jpg");
    const firstUpdate = directSnapshot("First update", "fingerprint-2", "cover-2.jpg");
    const secondUpdate = directSnapshot("Second update", "fingerprint-3", "cover-3.jpg");
    const plugin = trackerRegistry.get("rutor");
    if (!plugin?.direct) throw new Error("Rutor direct monitor is unavailable");
    const fetchSnapshot = vi.spyOn(plugin.direct, "fetchSnapshot")
      .mockResolvedValueOnce(baseline)
      .mockResolvedValueOnce(firstUpdate)
      .mockResolvedValueOnce(secondUpdate);
    const refresh = vi.fn<CoverCacheStore["refresh"]>()
      .mockResolvedValueOnce({
        cachedAt: timestamp,
        contentType: "image/jpeg",
        byteLength: 3,
        sourceUrl: baseline.coverUrl!,
      })
      .mockRejectedValueOnce(new Error("cover refresh timed out [ETIMEDOUT]"))
      .mockResolvedValueOnce({
        cachedAt: timestamp,
        contentType: "image/jpeg",
        byteLength: 4,
        sourceUrl: secondUpdate.coverUrl!,
      });
    const coverCache: CoverCacheStore = {
      has: vi.fn(() => true),
      refresh,
      read: vi.fn(),
      remove: vi.fn(),
    };
    const notifyRelease = vi.fn(async () => ({ delivered: true }));
    const telegram = { notifyRelease } as unknown as TelegramService;
    const scheduler = new Scheduler(db, telegram, new SecretVault(Buffer.alloc(32, 5)), coverCache);

    try {
      expect((await scheduler.run("test")).changed).toBe(0);
      expect(notifyRelease).not.toHaveBeenCalled();
      expect((await scheduler.run("test")).changed).toBe(1);
      expect(notifyRelease).toHaveBeenNthCalledWith(1, user.id, expect.objectContaining({
        release: firstUpdate,
        coverRefreshError: expect.stringContaining("ETIMEDOUT"),
      }));
      expect((await scheduler.run("test")).changed).toBe(1);
      expect(notifyRelease).toHaveBeenNthCalledWith(2, user.id, expect.objectContaining({
        release: secondUpdate,
      }));
      expect(refresh).toHaveBeenCalledTimes(3);
      expect(refresh.mock.calls.map((call) => call[1].coverUrl)).toEqual([
        baseline.coverUrl,
        firstUpdate.coverUrl,
        secondUpdate.coverUrl,
      ]);
    } finally {
      fetchSnapshot.mockRestore();
      db.close();
    }
  });

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
    const notifyRelease = vi.fn(async () => ({ delivered: true }));
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

function release(externalId: string): Release {
  return {
    trackerKey: "rutracker",
    externalId,
    title: `Needle release ${externalId}`,
    url: `https://rutracker.org/forum/viewtopic.php?t=${externalId}`,
  };
}

function feedBatch(releases: Release[], oldestObservedAt: string): DiscoveryBatch {
  const oldestMs = Date.parse(oldestObservedAt);
  const timestamped = releases.map((item, index) => ({
    ...item,
    publishedAt: new Date(oldestMs + index * 60_000).toISOString(),
  }));
  return {
    releases: timestamped,
    coverage: { source: "feed", complete: false, oldestObservedAt },
    cursor: timestamped.at(-1)?.publishedAt,
    sourceUrl: "https://feed.rutracker.cc/atom/f/0.atom",
  };
}

function directSnapshot(title: string, fingerprint: string, coverFile: string): DirectSnapshot {
  return {
    trackerKey: "rutor",
    externalId: "800",
    title,
    url: "https://rutor.is/torrent/800/test",
    coverUrl: `https://images.example/${coverFile}`,
    metadata: { snapshotVersion: 1, coverObserved: true },
    fingerprint,
  };
}

describe("feed-assisted RuTracker direct checks", () => {
  const topicUrl = "https://rutracker.org/forum/viewtopic.php?t=100";
  const hoursAgo = (hours: number) => new Date(Date.now() - hours * 60 * 60 * 1_000).toISOString();
  const feedEntry = (externalId: string, publishedAt: string, hash = externalId.padStart(40, "0")): Release => ({
    trackerKey: "rutracker",
    externalId,
    title: `Topic ${externalId}`,
    url: `https://rutracker.org/forum/viewtopic.php?t=${externalId}`,
    magnet: `magnet:?xt=urn:btih:${hash}`,
    publishedAt,
  });
  const feed = (...entries: Release[]): DiscoveryBatch => {
    const times = entries.map((entry) => entry.publishedAt!).sort();
    return { releases: entries, coverage: { source: "feed", complete: false, oldestObservedAt: times[0] }, cursor: times.at(-1) };
  };
  const topic = (title: string, hash: string): DirectSnapshot => ({
    trackerKey: "rutracker",
    externalId: "100",
    title,
    url: topicUrl,
    magnet: `magnet:?xt=urn:btih:${hash}`,
    metadata: { snapshotVersion: trackerRegistry.get("rutracker")!.manifest.snapshotVersion, coverObserved: true },
    fingerprint: `${title}:${hash}`,
  });
  // Three topics updated two to three hours ago, which the feed keeps listing unchanged.
  const quietFeed = () => [feedEntry("1", hoursAgo(3)), feedEntry("2", hoursAgo(2.5)), feedEntry("3", hoursAgo(2))];

  function setup(coverCache?: CoverCacheStore) {
    const db = createDatabase(":memory:");
    const user = db.prepare("SELECT id FROM users WHERE username = 'admin'").get() as { id: string };
    const collection = db.prepare("SELECT id FROM collections WHERE user_id = ?").get(user.id) as { id: string };
    const timestamp = new Date().toISOString();
    db.prepare(`INSERT INTO subscriptions (id, user_id, collection_id, type, name, direct_url, created_at, updated_at)
      VALUES ('topic', ?, ?, 'direct', '', ?, ?, ?)`).run(user.id, collection.id, topicUrl, timestamp, timestamp);
    db.prepare("INSERT INTO subscription_trackers (subscription_id, tracker_key) VALUES ('topic', 'rutracker')").run();
    const plugin = trackerRegistry.get("rutracker")!;
    const discover = vi.spyOn(plugin.rules!, "discover").mockResolvedValue(feed(...quietFeed()));
    const fetchSnapshot = vi.spyOn(plugin.direct!, "fetchSnapshot").mockResolvedValue(topic("Series 1-10", "AAA"));
    const telegram = { canNotify: () => false, notifyRelease: vi.fn() } as unknown as TelegramService;
    const scheduler = new Scheduler(db, telegram, new SecretVault(Buffer.alloc(32, 5)), coverCache);
    const outcomes = () => (db.prepare("SELECT outcome FROM tracker_observations WHERE operation = 'direct' ORDER BY rowid").all() as Array<{ outcome: string }>)
      .map((row) => row.outcome);
    const cleanup = () => { discover.mockRestore(); fetchSnapshot.mockRestore(); db.close(); };
    return { db, user, scheduler, discover, fetchSnapshot, outcomes, cleanup };
  }

  it("skips the page of a topic the feed has not listed since the last check, even with no rules on RuTracker", async () => {
    const { scheduler, discover, fetchSnapshot, outcomes, cleanup } = setup();
    try {
      await scheduler.run("baseline");
      const status = await scheduler.run("poll");
      expect(discover).toHaveBeenCalledTimes(2);
      expect(fetchSnapshot).toHaveBeenCalledTimes(1);
      expect(outcomes()).toEqual(["baseline", "feed-unchanged"]);
      expect(status).toMatchObject({ checked: 1, changed: 0, errors: 0 });
    } finally { cleanup(); }
  });

  it.each([
    ["skips a topic without a cover, which the cover cache never holds", undefined, ["baseline", "feed-unchanged"]],
    ["loads the page again while its cover is still missing from the cache", "https://images.example/cover.jpg", ["baseline", "unchanged"]],
  ] as const)("%s", async (_case, coverUrl, expected) => {
    const coverCache = {
      has: () => false,
      refresh: vi.fn(async () => { throw new Error("cover host unreachable"); }),
      remove: vi.fn(async () => undefined),
    } as unknown as CoverCacheStore;
    const { fetchSnapshot, outcomes, cleanup, scheduler } = setup(coverCache);
    fetchSnapshot.mockResolvedValue({ ...topic("Series 1-10", "AAA"), coverUrl });
    try {
      await scheduler.run("baseline");
      await scheduler.run("poll");
      expect(outcomes()).toEqual(expected);
    } finally { cleanup(); }
  });

  it("loads the page and reports the change when the feed lists the topic as updated", async () => {
    const { db, scheduler, discover, fetchSnapshot, outcomes, cleanup } = setup();
    try {
      await scheduler.run("baseline");
      // The page was last loaded two hours ago, and the torrent was replaced an hour ago.
      db.prepare("UPDATE subscriptions SET detail_verified_at = ? WHERE id = 'topic'").run(hoursAgo(2));
      discover.mockResolvedValue(feed(...quietFeed(), feedEntry("100", hoursAgo(1), "BBB")));
      fetchSnapshot.mockResolvedValue(topic("Series 1-11", "BBB"));
      await scheduler.run("poll");
      await scheduler.run("poll");
      expect(fetchSnapshot).toHaveBeenCalledTimes(2);
      expect(outcomes()).toEqual(["baseline", "changed", "feed-unchanged"]);
      expect(db.prepare("SELECT kind FROM subscription_events").all()).toEqual([{ kind: "direct-change" }]);
    } finally { cleanup(); }
  });

  it("loads every page after a gap in the feed", async () => {
    const { scheduler, discover, fetchSnapshot, outcomes, cleanup } = setup();
    try {
      await scheduler.run("baseline");
      discover.mockResolvedValue(feed(feedEntry("8", new Date().toISOString()), feedEntry("9", new Date().toISOString())));
      await scheduler.run("poll");
      expect(fetchSnapshot).toHaveBeenCalledTimes(2);
      expect(outcomes()).toEqual(["baseline", "unchanged"]);
    } finally { cleanup(); }
  });

  it("always loads the page when a check is requested", async () => {
    const { user, scheduler, fetchSnapshot, outcomes, cleanup } = setup();
    try {
      await scheduler.run("baseline");
      await scheduler.checkSubscription("topic", user.id);
      expect(fetchSnapshot).toHaveBeenCalledTimes(2);
      expect(outcomes()).toEqual(["baseline", "unchanged"]);
    } finally { cleanup(); }
  });
});
