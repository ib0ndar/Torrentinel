import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabase, nowIso, type SqliteDatabase } from "./db.js";
import { enqueueNotification, NotificationQueue } from "./notification-queue.js";
import { TelegramService, type ReleaseNotification } from "./telegram.js";
import { SecretVault, telegramTokenAad } from "./secrets.js";
import { Scheduler } from "./scheduler.js";
import { trackerRegistry } from "./trackers/index.js";

let db: SqliteDatabase, userId: string, collectionId: string;
const paths: string[] = [];
const notification: ReleaseNotification = { subscriptionId: "test", trackerName: "Rutor", release: { trackerKey: "rutor", externalId: "42", title: "Test release", url: "https://rutor.is/torrent/42" } };
function setup(databasePath = ":memory:") {
  db = createDatabase(databasePath);
  userId = (db.prepare("SELECT id FROM users WHERE username = 'admin'").get() as { id: string }).id;
  collectionId = (db.prepare("SELECT id FROM collections WHERE user_id = ?").get(userId) as { id: string }).id;
  const timestamp = nowIso();
  db.prepare(`INSERT OR IGNORE INTO subscriptions (id, user_id, collection_id, type, name, direct_url, created_at, updated_at)
    VALUES ('test', ?, ?, 'direct', 'Test release', ?, ?, ?)`).run(userId, collectionId, notification.release.url, timestamp, timestamp);
}
beforeEach(() => setup());
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); if (db.open) db.close(); for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true }); });
function queued() { return db.prepare("SELECT * FROM notification_queue").get() as { attempts: number; delivered_at: string | null; next_attempt_at: string; last_error: string | null; lease_until: string | null }; }
function sender(implementation: TelegramService["notifyRelease"] = async () => ({ delivered: true })) {
  return { notifyRelease: vi.fn(implementation), canNotify: () => false } as unknown as TelegramService;
}

describe("persistent notification outbox", () => {
  it("deduplicates enqueues and only acknowledges successful delivery", async () => {
    enqueueNotification(db, userId, "change:1", notification); enqueueNotification(db, userId, "change:1", notification);
    expect(db.prepare("SELECT COUNT(*) AS count FROM notification_queue").get()).toEqual({ count: 1 });
    const telegram = sender(), queue = new NotificationQueue(db, telegram);
    await queue.drain(); await queue.drain();
    expect(telegram.notifyRelease).toHaveBeenCalledTimes(1);
    expect(queued()).toMatchObject({ attempts: 1, last_error: null, lease_until: null, delivered_at: expect.any(String) });
  });
  it("rolls back notification work with its enclosing transaction", () => {
    expect(() => db.transaction(() => { enqueueNotification(db, userId, "rollback", notification); throw new Error("crash"); })()).toThrow("crash");
    expect(queued()).toBeUndefined();
  });
  it("never acknowledges a send that resolves without an explicit receipt", async () => {
    enqueueNotification(db, userId, "missing-receipt", notification);
    const telegram = { notifyRelease: vi.fn(async () => undefined) } as unknown as TelegramService;
    await new NotificationQueue(db, telegram).drain();
    expect(queued()).toMatchObject({ delivered_at: null, last_error: "Telegram delivery failed without a receipt" });
  });
  it("retries explicit failures with exponential backoff and eventually succeeds", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-30T00:00:00Z"));
    const telegram = sender(); vi.mocked(telegram.notifyRelease).mockResolvedValueOnce({ delivered: false, error: "offline" }).mockRejectedValueOnce(new Error("timeout"));
    const queue = new NotificationQueue(db, telegram); enqueueNotification(db, userId, "retry", notification);
    await queue.drain(); expect(queued()).toMatchObject({ attempts: 1, last_error: "offline", delivered_at: null, next_attempt_at: "2026-09-30T00:00:30.000Z" });
    await queue.drain(); expect(telegram.notifyRelease).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(30_000); await queue.drain(); expect(queued().next_attempt_at).toBe("2026-09-30T00:01:30.000Z");
    vi.advanceTimersByTime(60_000); await queue.drain(); expect(queued().delivered_at).not.toBeNull();
  });
  it("honors Telegram retry_after longer than the normal backoff", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-30T00:00:00Z"));
    enqueueNotification(db, userId, "rate-limit", notification);
    await new NotificationQueue(db, sender(async () => ({ delivered: false, retryAfterSeconds: 180, error: "rate limit" }))).drain();
    expect(queued().next_attempt_at).toBe("2026-09-30T00:03:00.000Z");
  });
  it("defers all pending sends for a rate-limited bot", async () => {
    enqueueNotification(db, userId, "limit:1", notification); enqueueNotification(db, userId, "limit:2", notification);
    const telegram = sender(async () => ({ delivered: false, retryAfterSeconds: 120, error: "rate limit" }));
    await new NotificationQueue(db, telegram).drain();
    expect(telegram.notifyRelease).toHaveBeenCalledTimes(1);
    expect(db.prepare("SELECT attempts FROM notification_queue ORDER BY rowid").all()).toEqual([{ attempts: 1 }, { attempts: 0 }]);
  });
  it("caps backoff without giving up on pending notifications", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-30T00:00:00Z"));
    enqueueNotification(db, userId, "long-outage", notification); db.prepare("UPDATE notification_queue SET attempts = 1000").run();
    await new NotificationQueue(db, sender(async () => ({ delivered: false, error: "offline" }))).drain();
    expect(queued()).toMatchObject({ attempts: 1001, delivered_at: null, next_attempt_at: "2026-09-30T06:00:00.000Z" });
  });
  it("persists failures across database close and restart", async () => {
    const path = mkdtempSync(join(tmpdir(), "torrentinel-outbox-")); paths.push(path); db.close(); setup(join(path, "test.db"));
    enqueueNotification(db, userId, "restart", notification);
    await new NotificationQueue(db, sender(async () => ({ delivered: false, error: "offline" }))).drain();
    db.close(); db = createDatabase(join(path, "test.db"));
    expect(queued()).toMatchObject({ attempts: 1, last_error: "offline", delivered_at: null });
    db.prepare("UPDATE notification_queue SET next_attempt_at = ?").run(nowIso());
    await new NotificationQueue(db, sender()).drain(); expect(queued().delivered_at).not.toBeNull();
  });
  it("recovers an expired in-flight lease but never steals an active lease", async () => {
    enqueueNotification(db, userId, "lease", notification);
    db.prepare("UPDATE notification_queue SET lease_until = ?, lease_token = 'old'").run(new Date(Date.now() + 60_000).toISOString());
    const telegram = sender(), queue = new NotificationQueue(db, telegram);
    await queue.drain(); expect(telegram.notifyRelease).not.toHaveBeenCalled();
    db.prepare("UPDATE notification_queue SET lease_until = ?").run(new Date(Date.now() - 1).toISOString());
    await queue.drain(); expect(telegram.notifyRelease).toHaveBeenCalledTimes(1);
  });
  it("coalesces drains and leases work across competing queue instances", async () => {
    let complete!: () => void;
    const telegram = sender(() => new Promise((resolve) => { complete = () => resolve({ delivered: true }); }));
    enqueueNotification(db, userId, "concurrent", notification);
    const queue = new NotificationQueue(db, telegram), first = queue.drain();
    expect(queue.drain()).toBe(first);
    await new NotificationQueue(db, telegram).drain(); expect(telegram.notifyRelease).toHaveBeenCalledTimes(1);
    complete(); await first;
  });
  it("waits for in-flight delivery on shutdown and cancels the worker timer", async () => {
    vi.useFakeTimers(); let complete!: () => void;
    enqueueNotification(db, userId, "shutdown", notification);
    const queue = new NotificationQueue(db, sender(() => new Promise((resolve) => { complete = () => resolve({ delivered: true }); })));
    queue.start(); let stopped = false; const stopping = queue.stop().then(() => { stopped = true; });
    expect(stopped).toBe(false); expect(vi.getTimerCount()).toBe(0); complete(); await stopping; expect(stopped).toBe(true);
  });
  it("retains undeliverable work until Telegram is configured", async () => {
    const vault = new SecretVault(Buffer.alloc(32, 9));
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ ok: true, result: { message_id: 1 } })));
    const queue = new NotificationQueue(db, new TelegramService(db, vault, fetcher));
    enqueueNotification(db, userId, "unlinked", notification); await queue.drain();
    expect(queued().delivered_at).toBeNull(); expect(fetcher).not.toHaveBeenCalled();
    db.prepare("INSERT INTO telegram_bots (user_id, token_encrypted, bot_username, configured_at, updated_at) VALUES (?, ?, 'test', ?, ?)")
      .run(userId, vault.encrypt("123456789:test-secret", telegramTokenAad(userId)), nowIso(), nowIso());
    db.prepare("INSERT INTO telegram_accounts (user_id, chat_id, linked_at) VALUES (?, '42', ?)").run(userId, nowIso());
    db.prepare("UPDATE notification_queue SET next_attempt_at = ?").run(nowIso());
    await queue.drain(); expect(queued().delivered_at).not.toBeNull(); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("does not send for disabled users and cascades deleted subscriptions", async () => {
    enqueueNotification(db, userId, "disabled", notification); db.prepare("UPDATE users SET disabled = 1 WHERE id = ?").run(userId);
    const telegram = sender(); await new NotificationQueue(db, telegram).drain(); expect(telegram.notifyRelease).not.toHaveBeenCalled();
    db.prepare("DELETE FROM subscriptions WHERE id = 'test'").run(); expect(queued()).toBeUndefined();
  });
  it("sanitizes failures and never prunes old pending work", async () => {
    enqueueNotification(db, userId, "old", notification);
    db.prepare("UPDATE notification_queue SET created_at = '2020-01-01'").run();
    await new NotificationQueue(db, sender(async () => { throw new Error("https://api.telegram.org/bot123:secret/sendMessage token=secret"); })).drain();
    expect(queued().last_error).not.toContain("secret"); expect(queued().delivered_at).toBeNull();
  });
});

describe("scheduler atomic outbox", () => {
  function directScheduler() {
    const plugin = trackerRegistry.get("rutor")!;
    db.prepare("INSERT INTO subscription_trackers (subscription_id, tracker_key) VALUES ('test', 'rutor')").run();
    const base = { ...notification.release, fingerprint: "old", metadata: { snapshotVersion: plugin.manifest.snapshotVersion, coverObserved: true } };
    db.prepare("UPDATE subscriptions SET initialized = 1, current_fingerprint = ?, current_snapshot = ? WHERE id = 'test'").run(base.fingerprint, JSON.stringify(base));
    vi.spyOn(plugin.direct!, "fetchSnapshot").mockResolvedValue({ ...base, title: "Changed", fingerprint: "new" });
    return new Scheduler(db, sender(), new SecretVault(Buffer.alloc(32, 8)));
  }
  it("leaves a direct change queued when the process stops before delivery", async () => {
    const scheduler = directScheduler();
    vi.spyOn(scheduler.notifications, "drain").mockRejectedValue(new Error("simulated crash before send"));
    await expect(scheduler.run("test")).rejects.toThrow("simulated crash");
    expect(db.prepare("SELECT current_fingerprint FROM subscriptions WHERE id = 'test'").get()).toEqual({ current_fingerprint: "new" });
    expect(db.prepare("SELECT COUNT(*) AS count FROM subscription_events").get()).toEqual({ count: 1 });
    expect(queued()).toMatchObject({ attempts: 0, delivered_at: null });
    const telegram = sender(); await new NotificationQueue(db, telegram).drain(); expect(telegram.notifyRelease).toHaveBeenCalledTimes(1);
  });
  it("rolls back the fingerprint and event if outbox persistence fails", async () => {
    const scheduler = directScheduler();
    db.exec("CREATE TRIGGER fail_queue BEFORE INSERT ON notification_queue BEGIN SELECT RAISE(ABORT, 'outbox unavailable'); END");
    expect((await scheduler.run("test")).errors).toBe(1);
    expect(db.prepare("SELECT current_fingerprint FROM subscriptions WHERE id = 'test'").get()).toEqual({ current_fingerprint: "old" });
    expect(db.prepare("SELECT COUNT(*) AS count FROM subscription_events").get()).toEqual({ count: 0 });
    expect(queued()).toBeUndefined();
  });
  it("inserts a new rule match and its outbox work atomically", async () => {
    const plugin = trackerRegistry.get("rutor")!;
    db.prepare("UPDATE subscriptions SET type = 'rule', required_terms = '[\"Test\"]', initialized = 1 WHERE id = 'test'").run();
    db.prepare("INSERT INTO subscription_trackers (subscription_id, tracker_key) VALUES ('test', 'rutor')").run();
    db.prepare("INSERT INTO subscription_tracker_state (subscription_id, tracker_key, initialized, discovery_revision) VALUES ('test', 'rutor', 1, ?)").run(plugin.manifest.ruleDiscoveryRevision ?? null);
    vi.spyOn(plugin.rules!, "discover").mockResolvedValue({ releases: [notification.release], coverage: { source: "recent-list", complete: true } });
    const scheduler = new Scheduler(db, sender(), new SecretVault(Buffer.alloc(32, 8)));
    db.exec("CREATE TRIGGER fail_queue BEFORE INSERT ON notification_queue BEGIN SELECT RAISE(ABORT, 'outbox unavailable'); END");
    await scheduler.run("test"); expect(db.prepare("SELECT COUNT(*) AS count FROM rule_matches").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM subscription_events").get()).toEqual({ count: 0 });
    db.exec("DROP TRIGGER fail_queue"); vi.spyOn(scheduler.notifications, "drain").mockResolvedValue();
    await scheduler.run("test"); expect(db.prepare("SELECT COUNT(*) AS count FROM rule_matches").get()).toEqual({ count: 1 }); expect(queued()).toMatchObject({ attempts: 0, delivered_at: null });
  });
});
