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
    } finally {
      db.close();
    }
  });
});
