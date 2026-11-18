import { nanoid } from "nanoid";
import { nowIso, type SqliteDatabase } from "./db.js";
import type { ReleaseNotification, TelegramService } from "./telegram.js";
import { safeDiagnosticText } from "./diagnostics.js";
import { nextDigestAt, notificationCategory, telegramPreferences } from "./telegram-preferences.js";

const LEASE_MS = 10 * 60_000;
const MAX_RETRY_MS = 6 * 60 * 60_000;

/** Call inside the same transaction that records the release. No network work. */
export function enqueueNotification(db: SqliteDatabase, userId: string, dedupeKey: string, notification: ReleaseNotification): void {
  if (!notification.subscriptionId) throw new Error("Queued notifications require a subscription");
  const subscription = db.prepare("SELECT telegram_muted FROM subscriptions WHERE id = ? AND user_id = ?")
    .get(notification.subscriptionId, userId) as { telegram_muted: number } | undefined;
  if (!subscription || subscription.telegram_muted) return;
  const mode = telegramPreferences(db, userId)[notificationCategory(notification)];
  if (mode === "off") return;
  const timestamp = nowIso();
  const digestAt = mode === "digest" ? nextDigestAt(timestamp) : null;
  db.prepare(`
    INSERT OR IGNORE INTO notification_queue
      (id, dedupe_key, user_id, subscription_id, payload, next_attempt_at, created_at, digest_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(nanoid(), dedupeKey, userId, notification.subscriptionId, JSON.stringify(notification), digestAt ?? timestamp, timestamp, digestAt);
}

interface QueueRow {
  id: string;
  user_id: string;
  payload: string;
  attempts: number;
  digest_at: string | null;
}

export class NotificationQueue {
  private timer?: NodeJS.Timeout;
  private active?: Promise<void>;
  private stopping = false;

  constructor(private readonly db: SqliteDatabase, private readonly telegram: TelegramService) {}

  start(): void {
    if (this.timer) return;
    this.stopping = false;
    this.timer = setInterval(() => this.wake(), 5_000);
    this.timer.unref();
    this.wake();
  }

  private wake(): void {
    void this.drain().catch((error: unknown) => console.error("Notification queue failed:", error));
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.active;
  }

  drain(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    if (this.active) return this.active;
    this.active = this.process().finally(() => { this.active = undefined; });
    return this.active;
  }

  private async process(): Promise<void> {
    // Bound each pass so shutdown and busy users cannot starve the application.
    for (let index = 0; index < 100 && !this.stopping; index += 1) {
      const delivery = this.db.transaction(() => {
        const timestamp = nowIso();
        const candidate = this.db.prepare(`
          SELECT q.id, q.user_id, q.payload, q.attempts, q.digest_at FROM notification_queue q
          JOIN users u ON u.id = q.user_id
          WHERE q.delivered_at IS NULL AND q.next_attempt_at <= ?
            AND (q.lease_until IS NULL OR q.lease_until <= ?) AND u.disabled = 0
          ORDER BY q.next_attempt_at, q.created_at, q.rowid LIMIT 1
        `).get(timestamp, timestamp) as QueueRow | undefined;
        if (!candidate) return;
        const rows = candidate.digest_at ? this.db.prepare(`
          SELECT id, user_id, payload, attempts, digest_at FROM notification_queue
          WHERE user_id = ? AND digest_at = ? AND delivered_at IS NULL AND next_attempt_at <= ?
            AND (lease_until IS NULL OR lease_until <= ?)
          ORDER BY next_attempt_at, created_at, rowid LIMIT 8
        `).all(candidate.user_id, candidate.digest_at, timestamp, timestamp) as QueueRow[] : [candidate];
        const token = nanoid();
        const lease = this.db.prepare(`UPDATE notification_queue SET lease_until = ?, lease_token = ?, attempts = attempts + 1 WHERE id = ?`);
        const until = new Date(Date.now() + LEASE_MS).toISOString();
        for (const row of rows) lease.run(until, token, row.id);
        return { userId: candidate.user_id, digest: Boolean(candidate.digest_at), token, rows };
      }).immediate();
      if (!delivery) break;
      const { userId, digest, token, rows } = delivery;
      let retryAfterSeconds = 0;
      try {
        const notifications = rows.map((row) => JSON.parse(row.payload) as ReleaseNotification);
        const result = digest ? await this.telegram.notifyDigest(userId, notifications) : await this.telegram.notifyRelease(userId, notifications[0]);
        if (!result?.delivered) {
          retryAfterSeconds = Number.isFinite(result?.retryAfterSeconds) && (result?.retryAfterSeconds ?? 0) > 0 ? result!.retryAfterSeconds! : 0;
          throw new Error(result?.error || "Telegram delivery failed without a receipt");
        }
        this.db.prepare(`UPDATE notification_queue SET delivered_at = ?, lease_until = NULL, lease_token = NULL, last_error = NULL
          WHERE lease_token = ?`).run(nowIso(), token);
      } catch (error) {
        const backoff = Math.min(MAX_RETRY_MS, 30_000 * 2 ** Math.min(Math.max(...rows.map((row) => row.attempts)), 10));
        const delay = Math.max(backoff, retryAfterSeconds * 1_000);
        const nextAttemptAt = new Date(Date.now() + delay).toISOString();
        this.db.prepare(`UPDATE notification_queue SET next_attempt_at = ?, lease_until = NULL, lease_token = NULL, last_error = ?
          WHERE lease_token = ?`).run(
          nextAttemptAt,
          safeDiagnosticText(error instanceof Error ? error.message : String(error)), token,
        );
        if (retryAfterSeconds > 0) {
          // A bot-level rate limit applies to all its pending sends, not just
          // this release. Other users' bots can continue independently.
          this.db.prepare(`UPDATE notification_queue SET next_attempt_at = MAX(next_attempt_at, ?)
            WHERE user_id = ? AND delivered_at IS NULL`).run(nextAttemptAt, userId);
        }
      }
    }
    // Retain receipts/dedupe keys for seven days, never prune pending work.
    this.db.prepare("DELETE FROM notification_queue WHERE delivered_at < ?")
      .run(new Date(Date.now() - 7 * 86_400_000).toISOString());
  }
}
