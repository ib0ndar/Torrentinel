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
