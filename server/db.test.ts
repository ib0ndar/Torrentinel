import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDatabase } from "./db.js";

const cleanup: string[] = [];

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("database migrations", () => {
  it("migrates the original 0.6.0 page-size constraint without losing users or related data", () => {
    const directory = mkdtempSync(join(tmpdir(), "torrentinel-page-size-migration-")); cleanup.push(directory);
    const path = join(directory, "old-v060.db");
    const legacy = createDatabase(path);
    legacy.exec(`ALTER TABLE users DROP COLUMN page_size;
      ALTER TABLE users ADD COLUMN page_size INTEGER NOT NULL DEFAULT 50 CHECK(page_size IN (25, 50, 100, 200));`);
    const admin = legacy.prepare("SELECT id FROM users WHERE username = 'admin'").get() as { id: string };
    legacy.prepare("UPDATE users SET page_size = 25, language = 'ru', pagination_enabled = 0 WHERE id = ?").run(admin.id);
    for (const size of [50, 100, 200]) legacy.prepare(`INSERT INTO users (id, username, password_hash, page_size, created_at, updated_at)
      VALUES (?, ?, 'existing-hash', ?, '2026-09-30', '2026-09-30')`).run(`user-${size}`, `user-${size}`, size);
    const before = legacy.prepare("SELECT * FROM users ORDER BY id").all() as Array<Record<string, unknown>>;
    const collections = legacy.prepare("SELECT * FROM collections").all();
    legacy.prepare("INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES ('existing-session', ?, '2030-01-01', '2026-09-30')").run(admin.id);
    legacy.close();
    for (let pass = 0; pass < 2; pass += 1) {
      const db = createDatabase(path);
      try {
        expect(db.prepare("SELECT * FROM users ORDER BY id").all()).toEqual(before.map((row) => ({ ...row, page_size: row.page_size === 25 ? 20 : row.page_size === 200 ? 100 : row.page_size })));
        expect(db.prepare("SELECT * FROM collections").all()).toEqual(collections);
        expect(db.prepare("SELECT user_id FROM sessions WHERE token_hash = 'existing-session'").get()).toEqual({ user_id: admin.id });
        expect(db.pragma("foreign_key_check")).toEqual([]);
        expect(db.pragma("quick_check", { simple: true })).toBe("ok");
        expect((db.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>).map((row) => row.name)).not.toContain("page_size_legacy");
        for (const size of [10, 20, 50, 100]) expect(() => db.prepare("UPDATE users SET page_size = ? WHERE id = ?").run(size, admin.id)).not.toThrow();
        for (const size of [25, 200, 0]) expect(() => db.prepare("UPDATE users SET page_size = ? WHERE id = ?").run(size, admin.id)).toThrow(/CHECK/);
        db.prepare("UPDATE users SET page_size = 20 WHERE id = ?").run(admin.id);
      } finally { db.close(); }
    }
  });
  it("merges legacy updated flags into unread activity without losing reminders or history", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "torrentinel-db-test-"));
    cleanup.push(dataDir);
    const databasePath = join(dataDir, "legacy.db");
    const legacy = createDatabase(databasePath);
    const user = legacy.prepare("SELECT id FROM users LIMIT 1").get() as { id: string };
    const collection = legacy.prepare("SELECT id FROM collections LIMIT 1").get() as { id: string };
    legacy.exec(`
      ALTER TABLE subscriptions ADD COLUMN is_updated INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE subscriptions ADD COLUMN last_viewed_at TEXT;
    `);
    const insert = legacy.prepare(`
      INSERT INTO subscriptions (id, user_id, collection_id, type, name, is_updated, manual_unread, created_at, updated_at)
      VALUES (?, ?, ?, 'direct', 'Example', ?, ?, '2026-01-01', '2026-01-01')
    `);
    insert.run("updated-only", user.id, collection.id, 1, 0);
    insert.run("manual", user.id, collection.id, 0, 1);
    insert.run("both", user.id, collection.id, 1, 1);
    insert.run("event-only", user.id, collection.id, 0, 0);
    insert.run("read", user.id, collection.id, 0, 0);
    legacy.prepare(`
      INSERT INTO subscription_events (id, subscription_id, user_id, kind, summary, created_at, read_at)
      VALUES (?, ?, ?, 'direct-change', 'Changed', '2026-01-01', ?)
    `).run("unread-event", "event-only", user.id, null);
    legacy.prepare(`
      INSERT INTO subscription_events (id, subscription_id, user_id, kind, summary, created_at, read_at)
      VALUES ('read-event', 'updated-only', ?, 'direct-change', 'Changed', '2026-01-01', '2026-01-02')
    `).run(user.id);
    legacy.close();

    // Reopening twice also verifies the migration is idempotent.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const db = createDatabase(databasePath);
      try {
        const columns = (db.prepare("PRAGMA table_info(subscriptions)").all() as Array<{ name: string }>).map((column) => column.name);
        expect(columns).not.toContain("is_updated");
        expect(columns).not.toContain("last_viewed_at");
        expect(db.prepare("SELECT id, manual_unread FROM subscriptions ORDER BY id").all()).toEqual([
          { id: "both", manual_unread: 1 },
          { id: "event-only", manual_unread: 0 },
          { id: "manual", manual_unread: 1 },
          { id: "read", manual_unread: 0 },
          { id: "updated-only", manual_unread: 1 },
        ]);
        expect(db.prepare("SELECT id, read_at FROM subscription_events ORDER BY id").all()).toEqual([
          { id: "read-event", read_at: "2026-01-02" },
          { id: "unread-event", read_at: null },
        ]);
      } finally {
        db.close();
      }
    }
  });

  it("adds the source-marker preference to existing users with icons enabled", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "torrentinel-db-test-"));
    cleanup.push(dataDir);
    const databasePath = join(dataDir, "legacy.db");
    const legacy = new Database(databasePath);
    legacy.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL COLLATE NOCASE UNIQUE,
        password_hash TEXT NOT NULL,
        is_admin INTEGER NOT NULL DEFAULT 0,
        disabled INTEGER NOT NULL DEFAULT 0,
        must_change_password INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    legacy.close();

    const db = createDatabase(databasePath);
    try {
      expect(db.prepare("SELECT tracker_marker_style FROM users WHERE username = 'admin'").get())
        .toEqual({ tracker_marker_style: "icons" });
      expect(db.prepare("SELECT language, pagination_enabled, page_size FROM users WHERE username = 'admin'").get())
        .toEqual({ language: "en", pagination_enabled: 1, page_size: 50 });
      expect(db.prepare("SELECT theme FROM users WHERE username = 'admin'").get()).toEqual({ theme: "sentinel" });
      expect(() => db.prepare("UPDATE users SET language = 'invalid'").run()).toThrow(/CHECK/);
      expect(() => db.prepare("UPDATE users SET page_size = 0").run()).toThrow(/CHECK/);
    } finally {
      db.close();
    }
  });
});
