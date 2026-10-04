import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { SqliteDatabase } from "../db.js";
import type { Scheduler } from "../scheduler.js";
import type { TelegramService } from "../telegram.js";
import type { SecretVault } from "../secrets.js";
import type { CoverCacheStore } from "../cover-cache.js";
import { TRACKER_KEYS, type TrackerKey } from "../types.js";
import { adapterForUrl, trackerRegistry } from "../trackers/index.js";
import { personalMirrorAllowed } from "../mirrors.js";

export interface RouteServices {
  app: FastifyInstance; db: SqliteDatabase; scheduler: Scheduler;
  telegram: TelegramService; vault: SecretVault; coverCache: CoverCacheStore;
}
export const idParams = z.object({ id: z.string().min(1).max(100) });
export const trackerKeySchema = z.enum(TRACKER_KEYS);
export const urlSchema = z.string().url().refine((value) => ["http:", "https:"].includes(new URL(value).protocol), {
  message: "Only HTTP and HTTPS URLs are supported",
});
export function parse<T>(schema: z.ZodType<T>, value: unknown, reply: { code: (status: number) => { send: (payload: unknown) => unknown } }): T | undefined {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  void reply.code(400).send({ error: "Invalid request", details: z.flattenError(result.error).fieldErrors });
}
export function origin(value: string): string { return new URL(value).origin; }
export function isUniqueError(error: unknown): boolean { return error instanceof Error && /UNIQUE constraint failed/i.test(error.message); }
export function ownsCollection(db: SqliteDatabase, id: string, userId: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM collections WHERE id = ? AND user_id = ?").get(id, userId));
}
export function ownsSubscription(db: SqliteDatabase, id: string, userId: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM subscriptions WHERE id = ? AND user_id = ?").get(id, userId));
}
export function jsonArray(value: string): string[] {
  try { const parsed: unknown = JSON.parse(value); return Array.isArray(parsed) ? parsed as string[] : []; } catch { return []; }
}
export function jsonObject(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try { return JSON.parse(value) as Record<string, unknown>; } catch { return null; }
}
export interface ResolvedMirrorRow { tracker_key: TrackerKey; display_name: string; global_base_url: string; user_base_url: string | null; base_url: string; enabled: number }
// A stored personal mirror that is no longer permitted (for example after the global mirror changed) is ignored.
export function resolvedMirrors(db: SqliteDatabase, userId: string): ResolvedMirrorRow[] {
  return (db.prepare(`SELECT tm.tracker_key, tm.display_name, tm.base_url AS global_base_url, tm.enabled, utm.base_url AS user_base_url
    FROM tracker_mirrors tm LEFT JOIN user_tracker_mirrors utm ON utm.tracker_key = tm.tracker_key AND utm.user_id = ?
    ORDER BY tm.display_name`).all(userId) as Array<Omit<ResolvedMirrorRow, "base_url">>).map((row) => {
    const personal = row.user_base_url && personalMirrorAllowed(row.tracker_key, row.user_base_url, row.global_base_url) ? row.user_base_url : null;
    return { ...row, user_base_url: personal, base_url: personal || row.global_base_url };
  });
}
export function globalMirrorUrl(db: SqliteDatabase, trackerKey: TrackerKey): string | undefined {
  return (db.prepare("SELECT base_url FROM tracker_mirrors WHERE tracker_key = ?").get(trackerKey) as { base_url: string } | undefined)?.base_url;
}
export function adapterForUserUrl(db: SqliteDatabase, userId: string, value: string) {
  const canonical = adapterForUrl(value);
  if (canonical) return canonical;
  const hostname = new URL(value).hostname.toLocaleLowerCase("en-US");
  const mirror = resolvedMirrors(db, userId).find((row) => {
    const mirrorHost = new URL(row.base_url).hostname.toLocaleLowerCase("en-US");
    return hostname === mirrorHost || hostname.endsWith(`.${mirrorHost}`);
  });
  return mirror ? trackerRegistry.get(mirror.tracker_key) : undefined;
}
