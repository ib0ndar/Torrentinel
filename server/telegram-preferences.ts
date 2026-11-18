import { z } from "zod";
import type { SqliteDatabase } from "./db.js";
import type { ReleaseNotification } from "./telegram.js";

const mode = z.enum(["immediate", "digest", "off"]);
export const telegramPreferencesSchema = z.object({ releases: mode, torrent: mode, appearance: mode, metadata: mode });
const defaults = { releases: "immediate", torrent: "immediate", appearance: "immediate", metadata: "immediate" } as const;

export function telegramPreferences(db: SqliteDatabase, userId: string): z.infer<typeof telegramPreferencesSchema> {
  const row = db.prepare("SELECT modes FROM telegram_preferences WHERE user_id = ?").get(userId) as { modes: string } | undefined;
  return row ? telegramPreferencesSchema.parse(JSON.parse(row.modes)) : defaults;
}

export function notificationCategory(notification: ReleaseNotification): keyof typeof defaults {
  if (notification.ruleTerms) return "releases";
  const changes = notification.changes ?? [];
  if (changes.includes("torrent file changed") || changes.includes("magnet changed")) return "torrent";
  if (changes.includes("title changed") || changes.includes("cover changed")) return "appearance";
  return "metadata";
}

export function nextDigestAt(timestamp: string): string {
  const due = new Date(timestamp);
  due.setUTCHours(9, 0, 0, 0);
  if (due.getTime() <= Date.parse(timestamp)) due.setUTCDate(due.getUTCDate() + 1);
  return due.toISOString();
}
