import { afterEach, describe, expect, it, vi } from "vitest";
import { createDatabase } from "./db.js";
import { Scheduler } from "./scheduler.js";
import { SecretVault } from "./secrets.js";
import type { TelegramService } from "./telegram.js";
import type { DirectSnapshot } from "./types.js";
import { trackerRegistry } from "./trackers/index.js";
import { TrackerError } from "./trackers/core/errors.js";
import type { CoverCacheStore } from "./cover-cache.js";

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function fixture() {
  const db = createDatabase(":memory:");
  const user = db.prepare("SELECT id FROM users WHERE username = 'admin'").get() as { id: string };
  const collection = db.prepare("SELECT id FROM collections WHERE user_id = ?").get(user.id) as { id: string };
  const notifyRelease = vi.fn<TelegramService["notifyRelease"]>(async () => ({ delivered: true }));
  const telegram = { canNotify: () => false, notifyRelease } as unknown as TelegramService;
  const scheduler = new Scheduler(db, telegram, new SecretVault(Buffer.alloc(32, 4)));
  return { db, user, collection, scheduler, notifyRelease };
}

describe("scheduler coordination", () => {
  it("cancels deferred subscription checks before closing the database", async () => {
    vi.useFakeTimers();
    const { db, user, scheduler } = fixture();
    const check = vi.spyOn(scheduler, "checkSubscription").mockResolvedValue();
    scheduler.queueSubscriptionCheck("one", user.id);
    await scheduler.stop();
    db.close();
    await vi.advanceTimersByTimeAsync(100);
    expect(check).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("waits for in-flight direct work before shutdown", async () => {
    const { db, user, collection, scheduler } = fixture();
    const timestamp = new Date().toISOString();
    db.prepare(`
      INSERT INTO subscriptions (id, user_id, collection_id, type, name, direct_url, created_at, updated_at)
      VALUES ('direct', ?, ?, 'direct', '', 'https://rutor.is/torrent/42', ?, ?)
    `).run(user.id, collection.id, timestamp, timestamp);
    db.prepare("INSERT INTO subscription_trackers (subscription_id, tracker_key) VALUES ('direct', 'rutor')").run();
    const result = deferred<DirectSnapshot>();
    const started = deferred<void>();
    vi.spyOn(trackerRegistry.get("rutor")!.direct!, "fetchSnapshot").mockImplementation(() => { started.resolve(); return result.promise; });
    try {
      const check = scheduler.checkSubscription("direct", user.id);
      await started.promise;
      let stopped = false;
      const stop = scheduler.stop().then(() => { stopped = true; });
      await Promise.resolve();
      expect(stopped).toBe(false);
      result.resolve({ trackerKey: "rutor", externalId: "42", title: "Release", url: "https://rutor.is/torrent/42", fingerprint: "baseline" });
      await Promise.all([check, stop]);
      expect(stopped).toBe(true);
      expect(db.prepare("SELECT initialized FROM subscriptions WHERE id = 'direct'").get()).toEqual({ initialized: 1 });
    } finally { db.close(); }
  });

  it("keeps tracker-wide feed gaps open after recovering only one rule", async () => {
    const { db, user, collection, scheduler } = fixture();
    const timestamp = new Date().toISOString();
    for (const id of ["one", "two"]) {
      db.prepare(`
        INSERT INTO subscriptions (id, user_id, collection_id, type, name, required_terms, created_at, updated_at)
        VALUES (?, ?, ?, 'rule', '', '["needle"]', ?, ?)
      `).run(id, user.id, collection.id, timestamp, timestamp);
      db.prepare("INSERT INTO subscription_trackers (subscription_id, tracker_key) VALUES (?, 'rutracker')").run(id);
    }
    const release = (id: string) => ({ trackerKey: "rutracker" as const, externalId: id, title: `Needle ${id}`, url: `https://rutracker.org/forum/viewtopic.php?t=${id}`, publishedAt: timestamp });
    const plugin = trackerRegistry.get("rutracker")!;
    const discover = vi.spyOn(plugin.rules!, "discover")
      .mockResolvedValueOnce({ releases: [release("1"), release("2")], coverage: { source: "feed", complete: false } })
      .mockResolvedValue({ releases: [release("3"), release("4")], coverage: { source: "feed", complete: false } });
    const recover = vi.spyOn(plugin.rules!, "recover").mockResolvedValue({ releases: [release("5")], coverage: { source: "search", complete: true } });
    try {
      await scheduler.run("test");
      await scheduler.checkSubscription("one", user.id);
      expect(recover).toHaveBeenCalledTimes(1);
      expect(scheduler.discoveryHealth()[0].unresolvedGapSince).toBeDefined();
      expect(db.prepare("SELECT COUNT(*) AS count FROM rule_matches WHERE subscription_id = 'two'").get()).toEqual({ count: 2 });
      await scheduler.run("test");
      expect(scheduler.discoveryHealth()[0].unresolvedGapSince).toBeUndefined();
      expect(db.prepare("SELECT COUNT(*) AS count FROM rule_matches WHERE subscription_id = 'two'").get()).toEqual({ count: 5 });
      expect(discover).toHaveBeenCalledTimes(3);
    } finally { db.close(); }
  });

  it.each([
    ["has no RuTracker login", new TrackerError("authentication", "RuTracker login is required to recover a feed coverage gap", { trackerKey: "rutracker" }), [0, 2, 2, 2]],
    ["needs more pages than the catch-up search reads", "incomplete", [0, 2, 2, 2]],
    ["fails once for a temporary reason", new TrackerError("network", "Request to rutracker.org failed", { trackerKey: "rutracker" }), [0, 2, 3, 3]],
  ] as const)("closes a feed gap without searching again for rules that caught up, when one rule %s", async (_case, failure, expectedCalls) => {
    const { db, user, collection, scheduler } = fixture();
    const timestamp = new Date().toISOString();
    for (const [id, term] of [["alpha", "alpha"], ["beta", "beta"]]) {
      db.prepare(`
        INSERT INTO subscriptions (id, user_id, collection_id, type, name, required_terms, created_at, updated_at)
        VALUES (?, ?, ?, 'rule', '', ?, ?, ?)
      `).run(id, user.id, collection.id, JSON.stringify([term]), timestamp, timestamp);
      db.prepare("INSERT INTO subscription_trackers (subscription_id, tracker_key) VALUES (?, 'rutracker')").run(id);
    }
    const release = (id: string) => ({ trackerKey: "rutracker" as const, externalId: id, title: `alpha beta ${id}`, url: `https://rutracker.org/forum/viewtopic.php?t=${id}`, publishedAt: timestamp });
    const plugin = trackerRegistry.get("rutracker")!;
    vi.spyOn(plugin.rules!, "discover")
      .mockResolvedValueOnce({ releases: [release("1"), release("2")], coverage: { source: "feed", complete: false } })
      .mockResolvedValue({ releases: [release("3"), release("4")], coverage: { source: "feed", complete: false } });
    let betaFailures = 0;
    const recover = vi.spyOn(plugin.rules!, "recover").mockImplementation(async (_context, query) => {
      if (query.requiredTerms[0] === "beta" && (failure === "incomplete" || betaFailures === 0 || failure.code === "authentication")) {
        betaFailures += 1;
        if (failure === "incomplete") return { releases: [release("5")], coverage: { source: "search", complete: false } };
        throw failure;
      }
      return { releases: [], coverage: { source: "search", complete: true } };
    });
    try {
      const calls: number[] = [];
      for (let poll = 0; poll < 4; poll += 1) {
        await scheduler.run("poll");
        calls.push(recover.mock.calls.length);
      }
      expect(calls).toEqual(expectedCalls);
      expect(scheduler.discoveryHealth()[0]).toMatchObject({ coverageStatus: "continuous", unresolvedGapSince: undefined });
    } finally { db.close(); }
  });

  it.each(["manual/manual", "scheduled/manual", "manual/scheduled"])("shares overlapping %s direct checks", async (order) => {
    const { db, user, collection, scheduler, notifyRelease } = fixture();
    const previous: DirectSnapshot = {
      trackerKey: "rutor", externalId: "42", title: "Series episode 1", url: "https://rutor.is/torrent/42",
      fingerprint: "previous", metadata: { coverObserved: true, snapshotVersion: 1 },
    };
    const timestamp = new Date().toISOString();
    db.prepare(`
      INSERT INTO subscriptions (id, user_id, collection_id, type, name, direct_url, initialized,
        current_fingerprint, current_snapshot, created_at, updated_at)
      VALUES ('direct', ?, ?, 'direct', ?, ?, 1, ?, ?, ?, ?)
    `).run(user.id, collection.id, previous.title, previous.url, previous.fingerprint, JSON.stringify(previous), timestamp, timestamp);
    db.prepare("INSERT INTO subscription_trackers (subscription_id, tracker_key) VALUES ('direct', 'rutor')").run();
    const plugin = trackerRegistry.get("rutor")!;
    const started = deferred<void>();
    const result = deferred<DirectSnapshot>();
    const fetchSnapshot = vi.spyOn(plugin.direct!, "fetchSnapshot").mockImplementation(() => {
      started.resolve();
      return result.promise;
    });
    try {
      const first = order.startsWith("scheduled") ? scheduler.run("test") : scheduler.checkSubscription("direct", user.id);
      await started.promise;
      const second = order.endsWith("scheduled") ? scheduler.run("test") : scheduler.checkSubscription("direct", user.id);
      let completed = false;
      void second.then(() => { completed = true; });
      await Promise.resolve();
      expect(completed).toBe(false);
      result.resolve({ ...previous, title: "Series episode 2", fingerprint: "updated" });
      await Promise.all([first, second]);
      expect(fetchSnapshot).toHaveBeenCalledTimes(1);
      expect(notifyRelease).toHaveBeenCalledTimes(1);
      expect(db.prepare("SELECT COUNT(*) AS count FROM subscription_events").get()).toEqual({ count: 1 });
      await scheduler.checkSubscription("direct", user.id);
      expect(fetchSnapshot).toHaveBeenCalledTimes(2);
      expect(notifyRelease).toHaveBeenCalledTimes(1);
    } finally { db.close(); }
  });

  it.each([false, true])("does not persist an old direct response/error after an edit (failed=%s)", async (failed) => {
    const { db, user, collection, scheduler, notifyRelease } = fixture();
    const timestamp = new Date().toISOString();
    db.prepare(`
      INSERT INTO subscriptions (id, user_id, collection_id, type, name, direct_url, created_at, updated_at)
      VALUES ('direct', ?, ?, 'direct', '', 'https://rutor.is/torrent/42', ?, ?)
    `).run(user.id, collection.id, timestamp, timestamp);
    db.prepare("INSERT INTO subscription_trackers (subscription_id, tracker_key) VALUES ('direct', 'rutor')").run();
    const started = deferred<void>();
    const result = deferred<DirectSnapshot>();
    vi.spyOn(trackerRegistry.get("rutor")!.direct!, "fetchSnapshot").mockImplementation(() => {
      started.resolve();
      return result.promise;
    });
    try {
      const check = scheduler.checkSubscription("direct", user.id);
      await started.promise;
      db.prepare("UPDATE subscriptions SET direct_url = 'https://rutor.is/torrent/43' WHERE id = 'direct'").run();
      if (failed) result.reject(new Error("old request failed"));
      else result.resolve({ trackerKey: "rutor", externalId: "42", title: "Old release", url: "https://rutor.is/torrent/42", fingerprint: "old" });
      await check;
      expect(db.prepare("SELECT initialized, current_snapshot, last_error FROM subscriptions WHERE id = 'direct'").get())
        .toEqual({ initialized: 0, current_snapshot: null, last_error: null });
      expect(notifyRelease).not.toHaveBeenCalled();
      expect(db.prepare("SELECT outcome FROM tracker_observations").get()).toEqual({ outcome: "superseded" });
    } finally { db.close(); }
  });

  it("discards snapshot and artwork when the URL changes during cover retrieval", async () => {
    const { db, user, collection, notifyRelease } = fixture();
    const timestamp = new Date().toISOString();
    db.prepare(`
      INSERT INTO subscriptions (id, user_id, collection_id, type, name, direct_url, created_at, updated_at)
      VALUES ('direct', ?, ?, 'direct', '', 'https://rutor.is/torrent/42', ?, ?)
    `).run(user.id, collection.id, timestamp, timestamp);
    db.prepare("INSERT INTO subscription_trackers (subscription_id, tracker_key) VALUES ('direct', 'rutor')").run();
    const snapshot: DirectSnapshot = {
      trackerKey: "rutor", externalId: "42", title: "Old release", url: "https://rutor.is/torrent/42",
      fingerprint: "old", coverUrl: "https://example.test/old-cover.jpg",
    };
    vi.spyOn(trackerRegistry.get("rutor")!.direct!, "fetchSnapshot").mockResolvedValue(snapshot);
    const started = deferred<void>();
    const result = deferred<Awaited<ReturnType<CoverCacheStore["refresh"]>>>();
    const coverCache: CoverCacheStore = {
      has: () => false, read: vi.fn(), remove: vi.fn(async () => undefined),
      refresh: vi.fn(() => { started.resolve(); return result.promise; }),
    };
    const scheduler = new Scheduler(db, { notifyRelease } as unknown as TelegramService, new SecretVault(Buffer.alloc(32, 4)), coverCache);
    try {
      const check = scheduler.checkSubscription("direct", user.id);
      await started.promise;
      db.prepare("UPDATE subscriptions SET direct_url = 'https://rutor.is/torrent/43' WHERE id = 'direct'").run();
      result.resolve({ sourceUrl: snapshot.coverUrl!, contentType: "image/jpeg", byteLength: 10, cachedAt: timestamp });
      await check;
      expect(db.prepare("SELECT initialized, current_snapshot FROM subscriptions WHERE id = 'direct'").get()).toEqual({ initialized: 0, current_snapshot: null });
      expect(coverCache.remove).toHaveBeenCalledWith("direct");
      expect(notifyRelease).not.toHaveBeenCalled();
    } finally { db.close(); }
  });

  it("retries a joined check for an edited topic instead of losing its new baseline", async () => {
    const { db, user, collection, scheduler, notifyRelease } = fixture();
    const timestamp = new Date().toISOString();
    db.prepare(`
      INSERT INTO subscriptions (id, user_id, collection_id, type, name, direct_url, created_at, updated_at)
      VALUES ('direct', ?, ?, 'direct', '', 'https://rutor.is/torrent/42', ?, ?)
    `).run(user.id, collection.id, timestamp, timestamp);
    db.prepare("INSERT INTO subscription_trackers (subscription_id, tracker_key) VALUES ('direct', 'rutor')").run();
    const started = deferred<void>();
    const oldResult = deferred<DirectSnapshot>();
    const fresh: DirectSnapshot = {
      trackerKey: "rutor", externalId: "43", title: "New topic", url: "https://rutor.is/torrent/43", fingerprint: "new",
    };
    const fetchSnapshot = vi.spyOn(trackerRegistry.get("rutor")!.direct!, "fetchSnapshot").mockImplementation(async (url) => {
      if (url.endsWith("/42")) { started.resolve(); return oldResult.promise; }
      return fresh;
    });
    try {
      const first = scheduler.checkSubscription("direct", user.id);
      await started.promise;
      db.prepare("UPDATE subscriptions SET direct_url = ? WHERE id = 'direct'").run(fresh.url);
      const joined = scheduler.checkSubscription("direct", user.id);
      oldResult.resolve({ ...fresh, externalId: "42", title: "Old topic", url: "https://rutor.is/torrent/42", fingerprint: "old" });
      await Promise.all([first, joined]);
      expect(fetchSnapshot).toHaveBeenCalledTimes(2);
      expect(db.prepare("SELECT initialized, current_fingerprint, current_snapshot FROM subscriptions WHERE id = 'direct'").get())
        .toEqual({ initialized: 1, current_fingerprint: fresh.fingerprint, current_snapshot: JSON.stringify(fresh) });
      expect(notifyRelease).not.toHaveBeenCalled();
    } finally { db.close(); }
  });

  it("checks only the requested rule, and serializes targeted checks with an active poll", async () => {
    const { db, user, collection, scheduler } = fixture();
    const timestamp = new Date().toISOString();
    for (const id of ["one", "two"]) {
      db.prepare(`
        INSERT INTO subscriptions (id, user_id, collection_id, type, name, required_terms, created_at, updated_at)
        VALUES (?, ?, ?, 'rule', '', ?, ?, ?)
      `).run(id, user.id, collection.id, JSON.stringify([id]), timestamp, timestamp);
      db.prepare("INSERT INTO subscription_trackers (subscription_id, tracker_key) VALUES (?, 'kinozal')").run(id);
    }
    const discover = vi.spyOn(trackerRegistry.get("kinozal")!.rules!, "discover")
      .mockResolvedValue({ releases: [], coverage: { source: "search", complete: false } });
    try {
      await scheduler.checkSubscription("one", user.id);
      expect(discover).toHaveBeenCalledTimes(1);
      expect(discover.mock.calls[0][1]).toEqual({ requiredTerms: ["one"] });
      expect(db.prepare("SELECT initialized FROM subscriptions WHERE id = 'two'").get()).toEqual({ initialized: 0 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM subscription_tracker_state WHERE subscription_id = 'two'").get()).toEqual({ count: 0 });

      discover.mockClear();
      const started = deferred<void>();
      const batch = deferred<Awaited<ReturnType<typeof discover>>>();
      discover.mockImplementationOnce(() => { started.resolve(); return batch.promise; });
      const fullPoll = scheduler.run("test");
      await started.promise;
      const targeted = scheduler.checkSubscription("two", user.id);
      const joined = scheduler.run("another-full-poll");
      batch.resolve({ releases: [], coverage: { source: "search", complete: false } });
      await Promise.all([fullPoll, targeted, joined]);
      expect(discover).toHaveBeenCalledTimes(3); // Two full-poll groups, then the target.
      expect(discover.mock.calls.at(-1)![1]).toEqual({ requiredTerms: ["two"] });
      expect(db.prepare("SELECT trigger FROM scheduler_runs ORDER BY rowid").all())
        .toEqual([{ trigger: "subscription" }, { trigger: "test" }, { trigger: "subscription" }]);
      expect(scheduler.status().running).toBe(false);
    } finally { db.close(); }
  });

  it("checks different trackers side by side and one tracker's subscriptions one at a time", async () => {
    const { db, user, collection, scheduler } = fixture();
    const timestamp = new Date().toISOString();
    const insertDirect = (id: string, tracker: string, url: string) => {
      db.prepare(`
        INSERT INTO subscriptions (id, user_id, collection_id, type, name, direct_url, created_at, updated_at)
        VALUES (?, ?, ?, 'direct', '', ?, ?, ?)
      `).run(id, user.id, collection.id, url, timestamp, timestamp);
      db.prepare("INSERT INTO subscription_trackers (subscription_id, tracker_key) VALUES (?, ?)").run(id, tracker);
    };
    insertDirect("rutor-1", "rutor", "https://rutor.is/torrent/1");
    insertDirect("rutor-2", "rutor", "https://rutor.is/torrent/2");
    insertDirect("rutracker-1", "rutracker", "https://rutracker.org/forum/viewtopic.php?t=1");
    const pending = new Map<string, ReturnType<typeof deferred<DirectSnapshot>>>();
    const started: string[] = [];
    const snapshot = (url: string): DirectSnapshot => ({
      trackerKey: url.includes("rutor.is") ? "rutor" : "rutracker", externalId: url.slice(-1), title: url, url, fingerprint: url,
    });
    // RuTracker's lane reads its feed first; a real request would make the test depend on the network.
    vi.spyOn(trackerRegistry.get("rutracker")!.rules!, "discover").mockResolvedValue({ releases: [], coverage: { source: "feed", complete: false } });
    const network = vi.spyOn(globalThis, "fetch");
    for (const key of ["rutor", "rutracker"] as const) {
      vi.spyOn(trackerRegistry.get(key)!.direct!, "fetchSnapshot").mockImplementation((url) => {
        started.push(url);
        const result = deferred<DirectSnapshot>();
        pending.set(url, result);
        return result.promise;
      });
    }
    try {
      const run = scheduler.run("test");
      await vi.waitFor(() => expect(started).toHaveLength(2));
      expect(started).toEqual(expect.arrayContaining(["https://rutor.is/torrent/1", "https://rutracker.org/forum/viewtopic.php?t=1"]));
      pending.get("https://rutor.is/torrent/1")!.resolve(snapshot("https://rutor.is/torrent/1"));
      await vi.waitFor(() => expect(started).toContain("https://rutor.is/torrent/2"));
      pending.get("https://rutor.is/torrent/2")!.resolve(snapshot("https://rutor.is/torrent/2"));
      pending.get("https://rutracker.org/forum/viewtopic.php?t=1")!.resolve(snapshot("https://rutracker.org/forum/viewtopic.php?t=1"));
      const status = await run;
      expect(status).toMatchObject({ checked: 3, errors: 0 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM subscriptions WHERE initialized = 1").get()).toEqual({ count: 3 });
      expect(network).not.toHaveBeenCalled();
    } finally { db.close(); }
  });

  it("finishes the other trackers when one tracker's lane fails unexpectedly", async () => {
    const { db, user, collection, scheduler } = fixture();
    const timestamp = new Date().toISOString();
    for (const [id, tracker, url] of [
      ["rutor-1", "rutor", "https://rutor.is/torrent/1"],
      ["rutracker-1", "rutracker", "https://rutracker.org/forum/viewtopic.php?t=1"],
    ]) {
      db.prepare(`
        INSERT INTO subscriptions (id, user_id, collection_id, type, name, direct_url, created_at, updated_at)
        VALUES (?, ?, ?, 'direct', '', ?, ?, ?)
      `).run(id, user.id, collection.id, url, timestamp, timestamp);
      db.prepare("INSERT INTO subscription_trackers (subscription_id, tracker_key) VALUES (?, ?)").run(id, tracker);
    }
    vi.spyOn(trackerRegistry.get("rutracker")!.rules!, "discover").mockResolvedValue({ releases: [], coverage: { source: "feed", complete: false } });
    const network = vi.spyOn(globalThis, "fetch");
    vi.spyOn(trackerRegistry.get("rutracker")!.direct!, "fetchSnapshot").mockResolvedValue({
      trackerKey: "rutracker", externalId: "1", title: "Topic", url: "https://rutracker.org/forum/viewtopic.php?t=1", fingerprint: "topic",
    });
    const internals = scheduler as unknown as { checkDirect: (row: { tracker_key: string }, ...rest: unknown[]) => Promise<string> };
    const checkDirect = internals.checkDirect.bind(scheduler);
    vi.spyOn(internals, "checkDirect").mockImplementation((row, ...rest) => (
      row.tracker_key === "rutor" ? Promise.reject(new Error("database is locked")) : checkDirect(row, ...rest)
    ));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const status = await scheduler.run("test");
      expect(status).toMatchObject({ checked: 1, errors: 1 });
      expect(db.prepare("SELECT initialized FROM subscriptions WHERE id = 'rutracker-1'").get()).toEqual({ initialized: 1 });
      expect(network).not.toHaveBeenCalled();
    } finally { db.close(); }
  });
});
