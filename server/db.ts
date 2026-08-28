import Database from "better-sqlite3";
import { hashSync } from "bcryptjs";
import { mkdirSync } from "node:fs";
import { nanoid } from "nanoid";
import { dirname } from "node:path";
import { config } from "./config.js";

export type SqliteDatabase = Database.Database;

export function nowIso(): string {
  return new Date().toISOString();
}

export function createDatabase(databasePath = config.databasePath): SqliteDatabase {
  mkdirSync(dirname(databasePath), { recursive: true });
  const db = new Database(databasePath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL COLLATE NOCASE UNIQUE,
      password_hash TEXT NOT NULL,
      is_admin INTEGER NOT NULL DEFAULT 0,
      disabled INTEGER NOT NULL DEFAULT 0,
      must_change_password INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);

    CREATE TABLE IF NOT EXISTS collections (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(user_id, name)
    );
    CREATE INDEX IF NOT EXISTS idx_collections_user ON collections(user_id);

    CREATE TABLE IF NOT EXISTS tracker_mirrors (
      tracker_key TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      base_url TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_tracker_mirrors (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      tracker_key TEXT NOT NULL REFERENCES tracker_mirrors(tracker_key) ON DELETE CASCADE,
      base_url TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(user_id, tracker_key)
    );

    CREATE TABLE IF NOT EXISTS user_tracker_credentials (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      tracker_key TEXT NOT NULL REFERENCES tracker_mirrors(tracker_key) ON DELETE CASCADE,
      username_encrypted TEXT NOT NULL,
      password_encrypted TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(user_id, tracker_key)
    );

    CREATE TABLE IF NOT EXISTS subscriptions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK(type IN ('direct', 'rule')),
      name TEXT NOT NULL,
      direct_url TEXT,
      required_terms TEXT NOT NULL DEFAULT '[]',
      ignored_terms TEXT NOT NULL DEFAULT '[]',
      enabled INTEGER NOT NULL DEFAULT 1,
      initialized INTEGER NOT NULL DEFAULT 0,
      last_checked_at TEXT,
      last_changed_at TEXT,
      last_viewed_at TEXT,
      last_error TEXT,
      current_fingerprint TEXT,
      current_snapshot TEXT,
      is_updated INTEGER NOT NULL DEFAULT 0,
      manual_unread INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_subscriptions_user_collection ON subscriptions(user_id, collection_id);
    CREATE INDEX IF NOT EXISTS idx_subscriptions_type_enabled ON subscriptions(type, enabled);

    CREATE TABLE IF NOT EXISTS subscription_cover_cache (
      subscription_id TEXT PRIMARY KEY REFERENCES subscriptions(id) ON DELETE CASCADE,
      source_url TEXT NOT NULL,
      content_type TEXT NOT NULL,
      file_name TEXT NOT NULL UNIQUE,
      byte_length INTEGER NOT NULL,
      cached_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_subscription_cover_cache_time ON subscription_cover_cache(cached_at DESC);

    CREATE TABLE IF NOT EXISTS subscription_trackers (
      subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
      tracker_key TEXT NOT NULL REFERENCES tracker_mirrors(tracker_key),
      PRIMARY KEY(subscription_id, tracker_key)
    );

    CREATE TABLE IF NOT EXISTS subscription_tracker_state (
      subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
      tracker_key TEXT NOT NULL REFERENCES tracker_mirrors(tracker_key),
      initialized INTEGER NOT NULL DEFAULT 0,
      discovery_revision TEXT,
      last_checked_at TEXT,
      last_error TEXT,
      PRIMARY KEY(subscription_id, tracker_key)
    );

    CREATE TABLE IF NOT EXISTS subscription_events (
      id TEXT PRIMARY KEY,
      subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      summary TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      read_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_events_subscription ON subscription_events(subscription_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_events_user_unread ON subscription_events(user_id, read_at);

    CREATE TABLE IF NOT EXISTS rule_matches (
      id TEXT PRIMARY KEY,
      subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
      tracker_key TEXT NOT NULL,
      external_id TEXT NOT NULL,
      title TEXT NOT NULL,
      url TEXT NOT NULL,
      magnet TEXT,
      torrent_url TEXT,
      discovered_at TEXT NOT NULL,
      UNIQUE(subscription_id, tracker_key, external_id)
    );
    CREATE INDEX IF NOT EXISTS idx_rule_matches_subscription ON rule_matches(subscription_id, discovered_at DESC);

    CREATE TABLE IF NOT EXISTS scheduler_runs (
      id TEXT PRIMARY KEY,
      trigger TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      checked INTEGER NOT NULL DEFAULT 0,
      changed INTEGER NOT NULL DEFAULT 0,
      errors INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_scheduler_runs_started ON scheduler_runs(started_at DESC);

    CREATE TABLE IF NOT EXISTS tracker_observations (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES scheduler_runs(id) ON DELETE CASCADE,
      subscription_id TEXT REFERENCES subscriptions(id) ON DELETE SET NULL,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      tracker_key TEXT NOT NULL,
      operation TEXT NOT NULL,
      outcome TEXT NOT NULL,
      requested_url TEXT,
      resolved_url TEXT,
      http_status INTEGER,
      external_id TEXT,
      title TEXT,
      fingerprint TEXT,
      has_cover INTEGER,
      has_magnet INTEGER,
      has_torrent_file INTEGER,
      release_count INTEGER,
      duration_ms INTEGER NOT NULL,
      error_code TEXT,
      error_message TEXT,
      details TEXT NOT NULL DEFAULT '{}',
      observed_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tracker_observations_time ON tracker_observations(observed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_tracker_observations_tracker ON tracker_observations(tracker_key, observed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_tracker_observations_subscription ON tracker_observations(subscription_id, observed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_tracker_observations_outcome ON tracker_observations(outcome, observed_at DESC);

    CREATE TABLE IF NOT EXISTS telegram_deliveries (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      subscription_id TEXT REFERENCES subscriptions(id) ON DELETE SET NULL,
      tracker_key TEXT,
      external_id TEXT,
      title TEXT,
      delivery_method TEXT NOT NULL,
      outcome TEXT NOT NULL,
      telegram_message_id INTEGER,
      error_message TEXT,
      artwork_error_message TEXT,
      duration_ms INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_telegram_deliveries_time ON telegram_deliveries(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_telegram_deliveries_user ON telegram_deliveries(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_telegram_deliveries_outcome ON telegram_deliveries(outcome, created_at DESC);

    CREATE TABLE IF NOT EXISTS telegram_bots (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      token_encrypted TEXT NOT NULL,
      bot_username TEXT NOT NULL,
      update_offset INTEGER NOT NULL DEFAULT 0,
      configured_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS telegram_accounts (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      chat_id TEXT NOT NULL,
      telegram_username TEXT,
      linked_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS telegram_link_codes (
      code TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_telegram_codes_expiry ON telegram_link_codes(expires_at);

    CREATE TABLE IF NOT EXISTS app_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  migrate(db);
  seed(db);
  return db;
}

function migrate(db: SqliteDatabase): void {
  const trackerStateColumns = db.prepare("PRAGMA table_info(subscription_tracker_state)")
    .all() as Array<{ name: string }>;
  if (!trackerStateColumns.some((column) => column.name === "discovery_revision")) {
    db.exec("ALTER TABLE subscription_tracker_state ADD COLUMN discovery_revision TEXT");
  }

  const telegramDeliveryColumns = db.prepare("PRAGMA table_info(telegram_deliveries)")
    .all() as Array<{ name: string }>;
  if (!telegramDeliveryColumns.some((column) => column.name === "artwork_error_message")) {
    db.exec("ALTER TABLE telegram_deliveries ADD COLUMN artwork_error_message TEXT");
  }

  const telegramAccounts = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'telegram_accounts'")
    .get() as { sql: string } | undefined;
  if (!telegramAccounts?.sql.includes("chat_id TEXT NOT NULL UNIQUE")) return;
  db.transaction(() => {
    db.exec(`
      ALTER TABLE telegram_accounts RENAME TO telegram_accounts_legacy;
      CREATE TABLE telegram_accounts (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        chat_id TEXT NOT NULL,
        telegram_username TEXT,
        linked_at TEXT NOT NULL
      );
      INSERT INTO telegram_accounts (user_id, chat_id, telegram_username, linked_at)
      SELECT user_id, chat_id, telegram_username, linked_at FROM telegram_accounts_legacy;
      DROP TABLE telegram_accounts_legacy;
    `);
  })();
}

function seed(db: SqliteDatabase): void {
  const timestamp = nowIso();
  const insertMirror = db.prepare(`
    INSERT INTO tracker_mirrors (tracker_key, display_name, base_url, enabled, updated_at)
    VALUES (?, ?, ?, 1, ?)
    ON CONFLICT(tracker_key) DO NOTHING
  `);
  insertMirror.run("kinozal", "Kinozal", "https://kinozal.tv", timestamp);
  insertMirror.run("rutor", "Rutor", "https://rutor.is", timestamp);
  insertMirror.run("rutracker", "RuTracker", "https://rutracker.org", timestamp);

  const userCount = db.prepare("SELECT COUNT(*) AS count FROM users").get() as { count: number };
  if (userCount.count === 0) {
    const userId = nanoid();
    db.prepare(`
      INSERT INTO users (
        id, username, password_hash, is_admin, disabled, must_change_password, created_at, updated_at
      ) VALUES (?, 'admin', ?, 1, 0, 1, ?, ?)
    `).run(userId, hashSync("admin", 12), timestamp, timestamp);
    db.prepare(`
      INSERT INTO collections (id, user_id, name, created_at, updated_at)
      VALUES (?, ?, 'Inbox', ?, ?)
    `).run(nanoid(), userId, timestamp, timestamp);
  }

  db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(timestamp);
  db.prepare("DELETE FROM telegram_link_codes WHERE expires_at <= ?").run(timestamp);
}
