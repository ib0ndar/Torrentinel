import { nanoid } from "nanoid";
import { nowIso, type SqliteDatabase } from "./db.js";
import type { ReleaseNotification, TelegramService } from "./telegram.js";
import { safeDiagnosticText } from "./diagnostics.js";

const LEASE_MS = 10 * 60_000;
const MAX_RETRY_MS = 6 * 60 * 60_000;

/** Call inside the same transaction that records the release. No network work. */
export function enqueueNotification(db: SqliteDatabase, userId: string, dedupeKey: string, notification: ReleaseNotification): void {
  if (!notification.subscriptionId) throw new Error("Queued notifications require a subscription");
  const timestamp = nowIso();
  db.prepare(`
    INSERT OR IGNORE INTO notification_queue
      (id, dedupe_key, user_id, subscription_id, payload, next_attempt_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(nanoid(), dedupeKey, userId, notification.subscriptionId, JSON.stringify(notification), timestamp, timestamp);
}

interface QueueRow {
  id: string;
  user_id: string;
  payload: string;
  attempts: number;
  lease_token: string;
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
      const row = this.db.transaction(() => {
        const timestamp = nowIso();
        const candidate = this.db.prepare(`
          SELECT q.id, q.user_id, q.payload, q.attempts FROM notification_queue q
          JOIN users u ON u.id = q.user_id
          WHERE q.delivered_at IS NULL AND q.next_attempt_at <= ?
            AND (q.lease_until IS NULL OR q.lease_until <= ?) AND u.disabled = 0
          ORDER BY q.next_attempt_at, q.created_at, q.rowid LIMIT 1
        `).get(timestamp, timestamp) as Omit<QueueRow, "lease_token"> | undefined;
        if (!candidate) return;
        const token = nanoid();
        this.db.prepare(`UPDATE notification_queue SET lease_until = ?, lease_token = ?, attempts = attempts + 1 WHERE id = ?`)
          .run(new Date(Date.now() + LEASE_MS).toISOString(), token, candidate.id);
        return { ...candidate, attempts: candidate.attempts + 1, lease_token: token };
      }).immediate();
      if (!row) break;
      let retryAfterSeconds = 0;
      try {
        const result = await this.telegram.notifyRelease(row.user_id, JSON.parse(row.payload) as ReleaseNotification);
        if (!result?.delivered) {
          retryAfterSeconds = Number.isFinite(result?.retryAfterSeconds) && (result?.retryAfterSeconds ?? 0) > 0 ? result!.retryAfterSeconds! : 0;
          throw new Error(result?.error || "Telegram delivery failed without a receipt");
        }
        this.db.prepare(`UPDATE notification_queue SET delivered_at = ?, lease_until = NULL, lease_token = NULL, last_error = NULL
          WHERE id = ? AND lease_token = ?`).run(nowIso(), row.id, row.lease_token);
      } catch (error) {
        const backoff = Math.min(MAX_RETRY_MS, 30_000 * 2 ** Math.min(row.attempts - 1, 10));
        const delay = Math.max(backoff, retryAfterSeconds * 1_000);
        const nextAttemptAt = new Date(Date.now() + delay).toISOString();
        this.db.prepare(`UPDATE notification_queue SET next_attempt_at = ?, lease_until = NULL, lease_token = NULL, last_error = ?
          WHERE id = ? AND lease_token = ?`).run(
          nextAttemptAt,
          safeDiagnosticText(error instanceof Error ? error.message : String(error)), row.id, row.lease_token,
        );
        if (retryAfterSeconds > 0) {
          // A bot-level rate limit applies to all its pending sends, not just
          // this release. Other users' bots can continue independently.
          this.db.prepare(`UPDATE notification_queue SET next_attempt_at = MAX(next_attempt_at, ?)
            WHERE user_id = ? AND delivered_at IS NULL`).run(nextAttemptAt, row.user_id);
        }
      }
    }
    // Retain receipts/dedupe keys for seven days, never prune pending work.
    this.db.prepare("DELETE FROM notification_queue WHERE delivered_at < ?")
      .run(new Date(Date.now() - 7 * 86_400_000).toISOString());
  }
}
