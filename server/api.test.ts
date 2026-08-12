import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApplication } from "./app.js";
import { recordTelegramDelivery, recordTrackerObservation, startSchedulerRun } from "./diagnostics.js";

const cleanup: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("authenticated API", () => {
  it("forces the initial password change and isolates each user's collections", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "torrentinel-test-"));
    cleanup.push(dataDir);
    const telegramFetch: typeof fetch = async () => new Response(JSON.stringify({
      ok: true,
      result: { id: 123456789, username: "torrentinel_test_bot" },
    }), { status: 200, headers: { "content-type": "application/json" } });
    const { app, db, scheduler } = await createApplication({
      databasePath: join(dataDir, "test.db"),
      encryptionKeyPath: join(dataDir, "master.key"),
      telegramFetch,
      logger: false,
      staticAssets: false,
    });
    vi.spyOn(scheduler, "checkSubscription").mockResolvedValue();

    try {
      const infoHash = "A".repeat(40);
      const magnetRedirect = await app.inject({ method: "GET", url: `/magnet/${infoHash}` });
      expect(magnetRedirect.statusCode).toBe(302);
      expect(magnetRedirect.headers.location).toBe(`magnet:?xt=urn:btih:${infoHash}`);
      const invalidMagnetRedirect = await app.inject({ method: "GET", url: "/magnet/not-a-hash" });
      expect(invalidMagnetRedirect.statusCode).toBe(400);

      const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "admin" } });
      expect(login.statusCode).toBe(200);
      expect(login.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
      const adminCookie = sessionCookie(login.headers["set-cookie"]!);

      const blockedAdmin = await app.inject({ method: "GET", url: "/api/admin/users", headers: { cookie: adminCookie } });
      expect(blockedAdmin.statusCode).toBe(428);

      const changed = await app.inject({
        method: "POST",
        url: "/api/auth/change-password",
        headers: { cookie: adminCookie },
        payload: { currentPassword: "admin", newPassword: "Admin-Test-2026!" },
      });
      expect(changed.statusCode).toBe(200);

      const trackerSettings = await app.inject({
        method: "PUT",
        url: "/api/trackers/rutracker/settings",
        headers: { cookie: adminCookie },
        payload: {
          baseUrl: "https://rutracker.net",
          username: "EncryptedTrackerUser",
          password: "EncryptedTrackerPassword!",
        },
      });
      expect(trackerSettings.statusCode).toBe(200);
      const trackerList = await app.inject({ method: "GET", url: "/api/trackers", headers: { cookie: adminCookie } });
      const rutracker = trackerList.json().trackers.find((tracker: { key: string }) => tracker.key === "rutracker");
      expect(rutracker).toMatchObject({
        username: "EncryptedTrackerUser",
        credentialsConfigured: true,
        baseUrl: "https://rutracker.net",
        snapshotVersion: 1,
        capabilities: {
          authentication: "optional",
          customMirrors: true,
          direct: true,
          rules: true,
          covers: true,
          ruleDiscovery: "feed",
        },
      });
      expect(rutracker).not.toHaveProperty("password");
      const storedCredentials = db.prepare(`
        SELECT username_encrypted, password_encrypted
        FROM user_tracker_credentials WHERE tracker_key = 'rutracker'
      `).get() as { username_encrypted: string; password_encrypted: string };
      expect(storedCredentials.username_encrypted).toMatch(/^v1:/);
      expect(storedCredentials.username_encrypted).not.toContain("EncryptedTrackerUser");
      expect(storedCredentials.password_encrypted).not.toContain("EncryptedTrackerPassword");

      const telegramToken = "not-a-real-telegram-token-for-testing";
      const configuredBot = await app.inject({
        method: "POST",
        url: "/api/telegram/bot",
        headers: { cookie: adminCookie },
        payload: { token: telegramToken },
      });
      expect(configuredBot.statusCode).toBe(200);
      expect(configuredBot.json().telegram).toMatchObject({
        configured: true,
        botUsername: "torrentinel_test_bot",
        linked: false,
      });
      const storedBot = db.prepare("SELECT token_encrypted FROM telegram_bots").get() as { token_encrypted: string };
      expect(storedBot.token_encrypted).toMatch(/^v1:/);
      expect(storedBot.token_encrypted).not.toContain(telegramToken);
      const linkCode = await app.inject({ method: "POST", url: "/api/telegram/link-code", headers: { cookie: adminCookie } });
      expect(linkCode.statusCode).toBe(200);
      expect(linkCode.json().link.deepLink).toContain("https://t.me/torrentinel_test_bot?start=");

      const privateCollection = await app.inject({
        method: "POST",
        url: "/api/collections",
        headers: { cookie: adminCookie },
        payload: { name: "Admin private" },
      });
      expect(privateCollection.statusCode).toBe(201);
      const privateCollectionId = privateCollection.json().collection.id as string;

      const olderRule = await app.inject({
        method: "POST",
        url: "/api/subscriptions",
        headers: { cookie: adminCookie },
        payload: {
          type: "rule",
          collectionId: privateCollectionId,
          trackerKeys: ["rutor"],
          requiredTerms: ["Older phrase"],
          ignoredTerms: [],
        },
      });
      expect(olderRule.statusCode).toBe(201);
      expect(olderRule.json().subscription).toMatchObject({ label: "Older phrase" });
      expect(olderRule.json().subscription.id).toMatch(/^\d+$/);

      const newerRule = await app.inject({
        method: "POST",
        url: "/api/subscriptions",
        headers: { cookie: adminCookie },
        payload: {
          type: "rule",
          collectionId: privateCollectionId,
          trackerKeys: ["rutor"],
          requiredTerms: ["Newer phrase", "2160p"],
          ignoredTerms: ["Trailer"],
        },
      });
      expect(newerRule.statusCode).toBe(201);
      expect(newerRule.json().subscription).toMatchObject({ label: "Newer phrase + 2160p" });
      expect(newerRule.json().subscription.id).toMatch(/^\d+$/);

      db.prepare(`
        UPDATE subscriptions SET created_at = ?, last_changed_at = ?, is_updated = 1 WHERE id = ?
      `).run("2026-01-01T00:00:00.000Z", "2026-12-31T00:00:00.000Z", olderRule.json().subscription.id);
      db.prepare("UPDATE subscriptions SET created_at = ? WHERE id = ?")
        .run("2026-01-02T00:00:00.000Z", newerRule.json().subscription.id);

      const mostRecentlyChangedFirst = await app.inject({
        method: "GET",
        url: `/api/subscriptions?collectionId=${privateCollectionId}`,
        headers: { cookie: adminCookie },
      });
      expect(mostRecentlyChangedFirst.statusCode).toBe(200);
      expect(mostRecentlyChangedFirst.json().subscriptions.map((subscription: { label: string }) => subscription.label))
        .toEqual(["Older phrase", "Newer phrase + 2160p"]);
      expect(db.prepare("SELECT DISTINCT name FROM subscriptions WHERE type = 'rule'").all())
        .toEqual([{ name: "" }]);

      const directSubscriptionId = "900002";
      const currentDirectSnapshot = {
        trackerKey: "rutor",
        externalId: "900002",
        title: "Series / Episodes 1-3 of 10",
        url: "https://rutor.is/torrent/900002/example",
        fingerprint: "current-direct-fingerprint",
      };
      db.prepare(`
        INSERT INTO subscriptions (
          id, user_id, collection_id, type, name, direct_url, initialized,
          current_fingerprint, current_snapshot, created_at, updated_at
        ) VALUES (?, ?, ?, 'direct', ?, ?, 1, ?, ?, ?, ?)
      `).run(
        directSubscriptionId, login.json().user.id, privateCollectionId,
        "Series / Episodes 1-2 of 10", currentDirectSnapshot.url,
        currentDirectSnapshot.fingerprint, JSON.stringify(currentDirectSnapshot),
        "2026-01-03T00:00:00.000Z", "2026-01-03T00:00:00.000Z",
      );
      db.prepare("INSERT INTO subscription_trackers (subscription_id, tracker_key) VALUES (?, 'rutor')")
        .run(directSubscriptionId);

      const listWithCurrentDirectTitle = await app.inject({
        method: "GET",
        url: `/api/subscriptions?collectionId=${privateCollectionId}`,
        headers: { cookie: adminCookie },
      });
      expect(listWithCurrentDirectTitle.json().subscriptions.find(
        (subscription: { id: string }) => subscription.id === directSubscriptionId,
      )).toMatchObject({ label: currentDirectSnapshot.title });
      const directDetails = await app.inject({
        method: "GET",
        url: `/api/subscriptions/${directSubscriptionId}`,
        headers: { cookie: adminCookie },
      });
      expect(directDetails.json().subscription).toMatchObject({ label: currentDirectSnapshot.title });

      const createdUser = await app.inject({
        method: "POST",
        url: "/api/admin/users",
        headers: { cookie: adminCookie },
        payload: { username: "member", password: "Member-Test-2026!", isAdmin: false },
      });
      expect(createdUser.statusCode).toBe(201);

      const memberLogin = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "member", password: "Member-Test-2026!" } });
      const memberCookie = sessionCookie(memberLogin.headers["set-cookie"]!);
      await app.inject({
        method: "POST",
        url: "/api/auth/change-password",
        headers: { cookie: memberCookie },
        payload: { currentPassword: "Member-Test-2026!", newPassword: "Member-Permanent-2026!" },
      });

      const memberTrackers = await app.inject({ method: "GET", url: "/api/trackers", headers: { cookie: memberCookie } });
      const memberRutracker = memberTrackers.json().trackers.find((tracker: { key: string }) => tracker.key === "rutracker");
      expect(memberRutracker.credentialsConfigured).toBe(false);
      expect(memberRutracker).not.toHaveProperty("username");
      const memberCollections = await app.inject({ method: "GET", url: "/api/collections", headers: { cookie: memberCookie } });
      expect(memberCollections.statusCode).toBe(200);
      expect(memberCollections.json().collections.map((value: { name: string }) => value.name)).toEqual(["Inbox"]);

      const crossUserDelete = await app.inject({ method: "DELETE", url: `/api/collections/${privateCollectionId}`, headers: { cookie: memberCookie } });
      expect(crossUserDelete.statusCode).toBe(404);
      const memberAdminAccess = await app.inject({ method: "GET", url: "/api/admin/users", headers: { cookie: memberCookie } });
      expect(memberAdminAccess.statusCode).toBe(403);

      const updatedInterval = await app.inject({
        method: "PUT",
        url: "/api/admin/settings/poll-interval",
        headers: { cookie: adminCookie },
        payload: { minutes: 5 },
      });
      expect(updatedInterval.statusCode).toBe(200);
      expect(updatedInterval.json().intervalMinutes).toBe(5);
      expect(db.prepare("SELECT value FROM app_state WHERE key = 'poll_interval_minutes'").get()).toMatchObject({ value: "5" });

      const systemStatus = await app.inject({ method: "GET", url: "/api/system/status", headers: { cookie: adminCookie } });
      expect(systemStatus.json().intervalMinutes).toBe(5);

      const diagnosticRunId = startSchedulerRun(db, "test", new Date().toISOString());
      recordTrackerObservation(db, {
        runId: diagnosticRunId,
        userId: login.json().user.id,
        trackerKey: "rutor",
        operation: "direct",
        outcome: "missing",
        requestedUrl: "https://rutor.is/torrent/42",
        durationMs: 120,
      });
      recordTelegramDelivery(db, {
        userId: login.json().user.id,
        trackerKey: "rutor",
        externalId: "42",
        title: "Fixture notification",
        deliveryMethod: "text",
        outcome: "delivered",
        telegramMessageId: 99,
        durationMs: 80,
      });
      const diagnostics = await app.inject({ method: "GET", url: "/api/admin/diagnostics", headers: { cookie: adminCookie } });
      expect(diagnostics.statusCode).toBe(200);
      expect(diagnostics.json()).toMatchObject({
        retentionHours: 168,
        observations: [{ trackerKey: "rutor", operation: "direct", outcome: "missing", username: "admin" }],
        telegramDeliveries: [{ trackerKey: "rutor", outcome: "delivered", telegramMessageId: 99, username: "admin" }],
      });

      const invalidInterval = await app.inject({
        method: "PUT",
        url: "/api/admin/settings/poll-interval",
        headers: { cookie: adminCookie },
        payload: { minutes: 361 },
      });
      expect(invalidInterval.statusCode).toBe(400);

      const memberIntervalUpdate = await app.inject({
        method: "PUT",
        url: "/api/admin/settings/poll-interval",
        headers: { cookie: memberCookie },
        payload: { minutes: 60 },
      });
      expect(memberIntervalUpdate.statusCode).toBe(403);
      const memberDiagnostics = await app.inject({ method: "GET", url: "/api/admin/diagnostics", headers: { cookie: memberCookie } });
      expect(memberDiagnostics.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });
});

function sessionCookie(value: string | string[]): string {
  return (Array.isArray(value) ? value[0] : value).split(";", 1)[0];
}
