import { z } from "zod";
import { nowIso } from "../db.js";
import { requireReadyUser } from "../auth.js";
import { listTrackers } from "../trackers/index.js";
import { readTrackerCredentials, writeTrackerCredentials } from "../secrets.js";
import { globalMirrorUrl, origin, parse, resolvedMirrors, trackerKeySchema, urlSchema, type RouteServices } from "./shared.js";
import { THEME_PREFERENCES, type TrackerKey } from "../types.js";
import { personalMirrorAllowed } from "../mirrors.js";
import type { SqliteDatabase } from "../db.js";

const MIRROR_NOT_ALLOWED = "Personal mirrors are limited to the tracker's own domains and the global mirror";
function mirrorRejected(db: SqliteDatabase, trackerKey: TrackerKey, baseUrl: string): boolean {
  const globalBaseUrl = globalMirrorUrl(db, trackerKey);
  return !globalBaseUrl || !personalMirrorAllowed(trackerKey, origin(baseUrl), globalBaseUrl);
}

export function registerSettingsRoutes({ app, db, vault, telegram }: RouteServices): void {
  app.put("/api/settings/preferences", { preHandler: requireReadyUser }, async (request, reply) => {
    const input = parse(z.object({ language: z.enum(["en", "ru"]).optional(), paginationEnabled: z.boolean().optional(),
      pageSize: z.union([z.literal(10), z.literal(20), z.literal(50), z.literal(100)]).optional(), theme: z.enum(THEME_PREFERENCES).optional() }), request.body, reply);
    if (!input || !request.user) return;
    const user = request.user;
    db.prepare(`UPDATE users SET language = ?, pagination_enabled = ?, page_size = ?, theme = ?, updated_at = ? WHERE id = ?`)
      .run(input.language ?? user.language, (input.paginationEnabled ?? user.paginationEnabled) ? 1 : 0, input.pageSize ?? user.pageSize, input.theme ?? user.theme, nowIso(), user.id);
    Object.assign(user, input);
    return { user };
  });
  app.put("/api/settings/source-markers", { preHandler: requireReadyUser }, async (request, reply) => {
    const input = parse(z.object({ trackerMarkerStyle: z.enum(["icons", "abbreviations"]) }), request.body, reply);
    if (!input || !request.user) return;
    db.prepare("UPDATE users SET tracker_marker_style = ?, updated_at = ? WHERE id = ?").run(input.trackerMarkerStyle, nowIso(), request.user.id);
    request.user.trackerMarkerStyle = input.trackerMarkerStyle;
    return { user: request.user };
  });
  app.get("/api/trackers", { preHandler: requireReadyUser }, async (request) => {
    const rows = resolvedMirrors(db, request.user!.id);
    return { trackers: listTrackers().map((tracker) => {
      const mirror = rows.find((row) => row.tracker_key === tracker.key)!;
      const credentials = readTrackerCredentials(db, vault, request.user!.id, tracker.key);
      return { ...tracker, baseUrl: mirror.base_url, globalBaseUrl: mirror.global_base_url, hasOverride: Boolean(mirror.user_base_url),
        enabled: Boolean(mirror.enabled), credentialsConfigured: Boolean(credentials), username: credentials?.username };
    }) };
  });
  app.put("/api/trackers/:trackerKey/settings", { preHandler: requireReadyUser }, async (request, reply) => {
    const params = parse(z.object({ trackerKey: trackerKeySchema }), request.params, reply);
    const input = parse(z.object({ baseUrl: urlSchema.nullable().optional(), username: z.string().trim().max(80).optional(),
      password: z.string().max(500).optional(), clearCredentials: z.boolean().default(false) }), request.body, reply);
    if (!params || !input || !request.user) return;
    if (input.baseUrl && mirrorRejected(db, params.trackerKey, input.baseUrl)) return reply.code(400).send({ error: MIRROR_NOT_ALLOWED });
    const userId = request.user.id, timestamp = nowIso();
    let credentials: { username: string; password: string } | undefined;
    if (!input.clearCredentials && (input.username !== undefined || input.password !== undefined)) {
      const existing = readTrackerCredentials(db, vault, userId, params.trackerKey);
      const username = input.username === undefined ? existing?.username || "" : input.username;
      const password = input.password || existing?.password || "";
      if (!username || !password) return reply.code(400).send({ error: "Both username and password are required to save tracker credentials" });
      credentials = { username, password };
    }
    db.transaction(() => {
      if (input.baseUrl !== undefined) {
        if (!input.baseUrl) db.prepare("DELETE FROM user_tracker_mirrors WHERE user_id = ? AND tracker_key = ?").run(userId, params.trackerKey);
        else db.prepare(`INSERT INTO user_tracker_mirrors (user_id, tracker_key, base_url, updated_at) VALUES (?, ?, ?, ?)
          ON CONFLICT(user_id, tracker_key) DO UPDATE SET base_url = excluded.base_url, updated_at = excluded.updated_at`).run(userId, params.trackerKey, origin(input.baseUrl), timestamp);
      }
      if (input.clearCredentials) db.prepare("DELETE FROM user_tracker_credentials WHERE user_id = ? AND tracker_key = ?").run(userId, params.trackerKey);
      else if (credentials) writeTrackerCredentials(db, vault, userId, params.trackerKey, credentials);
    })();
    return { ok: true };
  });
  app.put("/api/trackers/:trackerKey/mirror", { preHandler: requireReadyUser }, async (request, reply) => {
    const params = parse(z.object({ trackerKey: trackerKeySchema }), request.params, reply), input = parse(z.object({ baseUrl: urlSchema.nullable() }), request.body, reply);
    if (!params || !input || !request.user) return;
    if (input.baseUrl && mirrorRejected(db, params.trackerKey, input.baseUrl)) return reply.code(400).send({ error: MIRROR_NOT_ALLOWED });
    if (!input.baseUrl) db.prepare("DELETE FROM user_tracker_mirrors WHERE user_id = ? AND tracker_key = ?").run(request.user.id, params.trackerKey);
    else db.prepare(`INSERT INTO user_tracker_mirrors (user_id, tracker_key, base_url, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, tracker_key) DO UPDATE SET base_url = excluded.base_url, updated_at = excluded.updated_at`).run(request.user.id, params.trackerKey, origin(input.baseUrl), nowIso());
    return { ok: true };
  });
  app.get("/api/telegram", { preHandler: requireReadyUser }, async (request) => ({ telegram: telegram.statusForUser(request.user!.id) }));
  app.post("/api/telegram/bot", { preHandler: requireReadyUser }, async (request, reply) => {
    // BotFather tokens are <bot id>:<secret>; anything else is rejected before it reaches a Telegram API URL.
    const input = parse(z.object({ token: z.string().trim().regex(/^\d{3,20}:[A-Za-z0-9_-]{30,100}$/u) }), request.body, reply);
    if (!input || !request.user) return;
    return { telegram: await telegram.configureBot(request.user.id, input.token) };
  });
  app.delete("/api/telegram/bot", { preHandler: requireReadyUser }, async (request) => { await telegram.removeBot(request.user!.id); return { ok: true }; });
  app.post("/api/telegram/link-code", { preHandler: requireReadyUser }, async (request, reply) => {
    if (!telegram.statusForUser(request.user!.id).configured) return reply.code(503).send({ error: "Telegram bot is not configured" });
    return { link: telegram.createLink(request.user!.id) };
  });
  app.delete("/api/telegram", { preHandler: requireReadyUser }, async (request) => { telegram.unlink(request.user!.id); return { ok: true }; });
}
