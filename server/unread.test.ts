import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createApplication } from "./app.js";

describe("subscription unread activity", () => {
  it.each(["direct", "rule"])("opens %s subscriptions as read and preserves later activity and manual reminders", async (type) => {
    const dataDir = mkdtempSync(join(tmpdir(), "torrentinel-unread-test-"));
    const { app, db } = await createApplication({
      databasePath: join(dataDir, "test.db"),
      encryptionKeyPath: join(dataDir, "master.key"),
      logger: false,
      staticAssets: false,
    });
    try {
      db.prepare("UPDATE users SET must_change_password = 0 WHERE username = 'admin'").run();
      const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "admin" } });
      const rawCookie = login.headers["set-cookie"]!;
      const headers = { cookie: (Array.isArray(rawCookie) ? rawCookie[0]! : rawCookie).split(";")[0]! };
      const userId = login.json().user.id as string;
      const { id: collectionId } = db.prepare("SELECT id FROM collections WHERE user_id = ?").get(userId) as { id: string };
      db.prepare(`
        INSERT INTO subscriptions (id, user_id, collection_id, type, name, initialized, created_at, updated_at)
        VALUES ('1', ?, ?, ?, 'Example subscription', 1, '2026-01-01', '2026-01-01')
      `).run(userId, collectionId, type);
      const addEvent = db.prepare(`
        INSERT INTO subscription_events (id, subscription_id, user_id, kind, summary, created_at)
        VALUES (?, '1', ?, ?, 'New activity', '2026-01-02')
      `);
      // Reading a subscription must acknowledge its history beyond the display limit.
      for (let index = 0; index < 105; index += 1) addEvent.run(`event-${index}`, userId, type === "direct" ? "direct-change" : "rule-match");
      const detail = () => app.inject({ method: "GET", url: "/api/subscriptions/1", headers });
      const open = () => app.inject({ method: "POST", url: "/api/subscriptions/1/open", headers });
      const read = (value: boolean) => app.inject({ method: "POST", url: "/api/subscriptions/1/read", headers, payload: { read: value } });
      const collection = async () => (await app.inject({ method: "GET", url: "/api/collections", headers })).json().collections[0];

      expect((await detail()).json().subscription).toMatchObject({ isUnread: true, unreadCount: 105 });
      expect(await collection()).toMatchObject({ unreadCount: 1 });
      expect(await collection()).not.toHaveProperty("updatedCount");

      const unauthenticated = await app.inject({ method: "POST", url: "/api/subscriptions/1/open" });
      expect(unauthenticated.statusCode).toBe(401);
      const missing = await app.inject({ method: "POST", url: "/api/subscriptions/missing/open", headers });
      expect(missing.statusCode).toBe(404);
      db.prepare(`INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES ('other', 'other', 'unused', '2026-01-01', '2026-01-01')`).run();
      db.prepare("UPDATE subscriptions SET user_id = 'other' WHERE id = '1'").run();
      expect((await open()).statusCode).toBe(404);
      db.prepare("UPDATE subscriptions SET user_id = ? WHERE id = '1'").run(userId);
      expect((await detail()).json().subscription.unreadCount).toBe(105);

      const opened = await open();
      expect(opened.statusCode).toBe(200);
      expect(opened.json().subscription).toMatchObject({ isUnread: false, unreadCount: 0 });
      expect(opened.json().subscription).not.toHaveProperty("isUpdated");
      expect(opened.json().events).toHaveLength(100);
      expect(opened.json().events.every((event: { readAt: string | null }) => event.readAt)).toBe(true);
      expect(await collection()).toMatchObject({ unreadCount: 0 });
      const originalReadAt = db.prepare("SELECT read_at FROM subscription_events WHERE id = 'event-0'").get();

      addEvent.run("later", userId, type === "direct" ? "direct-change" : "rule-match");
      expect((await detail()).json().subscription).toMatchObject({ isUnread: true, unreadCount: 1 });
      expect(await collection()).toMatchObject({ unreadCount: 1 });
      expect((await read(true)).statusCode).toBe(200);
      expect((await detail()).json().subscription).toMatchObject({ isUnread: false, unreadCount: 0 });
      expect(db.prepare("SELECT read_at FROM subscription_events WHERE id = 'event-0'").get()).toEqual(originalReadAt);

      expect((await read(false)).statusCode).toBe(200);
      // Ordinary detail refreshes must not clear a manual reminder.
      expect((await detail()).json().subscription).toMatchObject({ isUnread: true, unreadCount: 0 });
      expect((await detail()).json().subscription.isUnread).toBe(true);
      expect(await collection()).toMatchObject({ unreadCount: 1 });
      expect((await open()).json().subscription).toMatchObject({ isUnread: false, unreadCount: 0 });
      expect(await collection()).toMatchObject({ unreadCount: 0 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM subscription_events").get()).toEqual({ count: 106 });
    } finally {
      await app.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
