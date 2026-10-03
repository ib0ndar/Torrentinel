import { hash } from "bcryptjs";
import { nanoid } from "nanoid";
import { z } from "zod";
import { nowIso, type SqliteDatabase } from "../db.js";
import { requireAdmin } from "../auth.js";
import { DIAGNOSTIC_RETENTION_HOURS, diagnosticCutoffIso, pruneDiagnostics } from "../diagnostics.js";
import { idParams, isUniqueError, jsonObject, origin, parse, trackerKeySchema, urlSchema, type RouteServices } from "./shared.js";
import { LABEL_SQL } from "./subscriptions.js";

const OPERATIONS = ["direct", "feed-poll", "rule-discovery", "rule-enrichment"] as const;
const outcomeSchema = z.string().trim().min(1).max(40);
const pageSchema = { page: z.coerce.number().int().min(1).max(1_000_000).default(1), pageSize: z.coerce.number().int().min(1).max(200).optional() };
// The subscription's display label (rule phrases, release title or stored name); empty when it was deleted.
const SUBSCRIPTION_NAME_SQL = `NULLIF(${LABEL_SQL}, '') AS subscription_name`;
const OBSERVATION_SQL = `SELECT o.*, u.username, ${SUBSCRIPTION_NAME_SQL} FROM tracker_observations o JOIN users u ON u.id = o.user_id
  LEFT JOIN subscriptions s ON s.id = o.subscription_id`;
const DELIVERY_SQL = `SELECT d.*, u.username, ${SUBSCRIPTION_NAME_SQL} FROM telegram_deliveries d JOIN users u ON u.id = d.user_id
  LEFT JOIN subscriptions s ON s.id = d.subscription_id`;

export function registerAdminRoutes({ app, db }: RouteServices): void {
  // Combined snapshot with fixed limits, kept for API clients; the web interface uses the paged endpoints below.
  app.get("/api/admin/diagnostics", { preHandler: requireAdmin }, async (request, reply) => {
    const query = parse(z.object({ trackerKey: trackerKeySchema.optional(), operation: z.enum(OPERATIONS).optional(),
      outcome: outcomeSchema.optional(), limit: z.coerce.number().int().min(1).max(250).default(100) }), request.query, reply);
    if (!query) return;
    pruneDiagnostics(db);
    const cutoff = diagnosticCutoffIso(), filter = observationFilter(cutoff, query);
    const observations = db.prepare(`${OBSERVATION_SQL} WHERE ${filter.where} ORDER BY o.observed_at DESC LIMIT ?`).all(...filter.parameters, query.limit);
    const runs = db.prepare(`SELECT id, trigger, started_at, finished_at, checked, changed, errors, duration_ms FROM scheduler_runs
      WHERE COALESCE(finished_at, started_at) >= ? ORDER BY started_at DESC LIMIT 20`).all(cutoff);
    const deliveries = db.prepare(`${DELIVERY_SQL} WHERE d.created_at >= ? ORDER BY d.created_at DESC LIMIT ?`).all(cutoff, query.limit);
    return { retentionHours: DIAGNOSTIC_RETENTION_HOURS, generatedAt: nowIso(), observations: observations.map(serializeObservation),
      runs: runs.map(camelRow), telegramDeliveries: deliveries.map(camelRow), notificationQueue: notificationQueue(db, query.limit) };
  });
  app.get("/api/admin/diagnostics/observations", { preHandler: requireAdmin }, async (request, reply) => {
    const query = parse(z.object({ trackerKey: trackerKeySchema.optional(), operation: z.enum(OPERATIONS).optional(), outcome: outcomeSchema.optional(), ...pageSchema }), request.query, reply);
    if (!query || !request.user) return;
    pruneDiagnostics(db);
    const cutoff = diagnosticCutoffIso(), filter = observationFilter(cutoff, query), pageSize = query.pageSize ?? request.user.pageSize;
    const total = (db.prepare(`SELECT COUNT(*) AS count FROM tracker_observations o WHERE ${filter.where}`).get(...filter.parameters) as { count: number }).count;
    const pageCount = Math.max(1, Math.ceil(total / pageSize)), page = Math.min(query.page, pageCount);
    const observations = db.prepare(`${OBSERVATION_SQL} WHERE ${filter.where} ORDER BY o.observed_at DESC, o.rowid DESC LIMIT ? OFFSET ?`)
      .all(...filter.parameters, pageSize, (page - 1) * pageSize);
    // Outcomes recorded in the retention window (for the selected tracker), so the filter offers values beyond this page.
    const outcomes = (db.prepare(`SELECT DISTINCT outcome FROM tracker_observations WHERE observed_at >= ?${query.trackerKey ? " AND tracker_key = ?" : ""} ORDER BY outcome`)
      .all(cutoff, ...query.trackerKey ? [query.trackerKey] : []) as Array<{ outcome: string }>).map((row) => row.outcome);
    return { retentionHours: DIAGNOSTIC_RETENTION_HOURS, observations: observations.map(serializeObservation), outcomes, total, page, pageSize, pageCount };
  });
  app.get("/api/admin/diagnostics/deliveries", { preHandler: requireAdmin }, async (request, reply) => {
    const query = parse(z.object(pageSchema), request.query, reply);
    if (!query || !request.user) return;
    pruneDiagnostics(db);
    const cutoff = diagnosticCutoffIso(), pageSize = query.pageSize ?? request.user.pageSize;
    const total = (db.prepare("SELECT COUNT(*) AS count FROM telegram_deliveries WHERE created_at >= ?").get(cutoff) as { count: number }).count;
    const pageCount = Math.max(1, Math.ceil(total / pageSize)), page = Math.min(query.page, pageCount);
    const deliveries = db.prepare(`${DELIVERY_SQL} WHERE d.created_at >= ? ORDER BY d.created_at DESC, d.rowid DESC LIMIT ? OFFSET ?`).all(cutoff, pageSize, (page - 1) * pageSize);
    return { retentionHours: DIAGNOSTIC_RETENTION_HOURS, telegramDeliveries: deliveries.map(camelRow), total, page, pageSize, pageCount };
  });
  app.get("/api/admin/diagnostics/queue", { preHandler: requireAdmin }, async () => ({ generatedAt: nowIso(), notificationQueue: notificationQueue(db, 100) }));
  app.get("/api/admin/users", { preHandler: requireAdmin }, async () => ({ users: db.prepare(`SELECT u.id, u.username, u.is_admin, u.disabled, u.must_change_password, u.created_at,
    (SELECT COUNT(*) FROM collections c WHERE c.user_id = u.id) AS collection_count, (SELECT COUNT(*) FROM subscriptions s WHERE s.user_id = u.id) AS subscription_count
    FROM users u ORDER BY u.created_at`).all().map((value) => {
      const row = value as Record<string, unknown>;
      return { ...camelRow(row), isAdmin: Boolean(row.is_admin), disabled: Boolean(row.disabled), mustChangePassword: Boolean(row.must_change_password) };
    }) }));
  app.post("/api/admin/users", { preHandler: requireAdmin }, async (request, reply) => {
    const input = parse(z.object({ username: z.string().trim().min(1).max(80), password: z.string().min(8).max(500), isAdmin: z.boolean().default(false) }), request.body, reply);
    if (!input) return;
    const id = nanoid(), timestamp = nowIso(), passwordHash = await hash(input.password, 12);
    try {
      db.transaction(() => {
        db.prepare(`INSERT INTO users (id, username, password_hash, is_admin, must_change_password, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)`)
          .run(id, input.username, passwordHash, input.isAdmin ? 1 : 0, timestamp, timestamp);
        db.prepare("INSERT INTO collections (id, user_id, name, created_at, updated_at) VALUES (?, ?, 'Inbox', ?, ?)").run(nanoid(), id, timestamp, timestamp);
      })();
    } catch (error) { if (isUniqueError(error)) return reply.code(409).send({ error: "Username already exists" }); throw error; }
    return reply.code(201).send({ user: { id, username: input.username, isAdmin: input.isAdmin, mustChangePassword: true } });
  });
  app.patch("/api/admin/users/:id", { preHandler: requireAdmin }, async (request, reply) => {
    const params = parse(idParams, request.params, reply), input = parse(z.object({ disabled: z.boolean().optional(), isAdmin: z.boolean().optional() }), request.body, reply);
    if (!params || !input || !request.user) return;
    if (params.id === request.user.id && (input.disabled || input.isAdmin === false)) return reply.code(400).send({ error: "You cannot disable or demote your current account" });
    const current = db.prepare("SELECT disabled, is_admin FROM users WHERE id = ?").get(params.id) as { disabled: number; is_admin: number } | undefined;
    if (!current) return reply.code(404).send({ error: "User not found" });
    db.prepare("UPDATE users SET disabled = ?, is_admin = ?, updated_at = ? WHERE id = ?").run(input.disabled === undefined ? current.disabled : input.disabled ? 1 : 0,
      input.isAdmin === undefined ? current.is_admin : input.isAdmin ? 1 : 0, nowIso(), params.id);
    if (input.disabled) db.prepare("DELETE FROM sessions WHERE user_id = ?").run(params.id);
    return { ok: true };
  });
  app.post("/api/admin/users/:id/reset-password", { preHandler: requireAdmin }, async (request, reply) => {
    const params = parse(idParams, request.params, reply), input = parse(z.object({ password: z.string().min(8).max(500) }), request.body, reply);
    if (!params || !input) return;
    if (!db.prepare("UPDATE users SET password_hash = ?, must_change_password = 1, updated_at = ? WHERE id = ?").run(await hash(input.password, 12), nowIso(), params.id).changes) return reply.code(404).send({ error: "User not found" });
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(params.id); return { ok: true };
  });
  app.get("/api/admin/mirrors", { preHandler: requireAdmin }, async () => ({ mirrors: db.prepare("SELECT tracker_key, display_name, base_url, enabled, updated_at FROM tracker_mirrors ORDER BY display_name")
    .all().map((value) => { const row = value as Record<string, unknown>; return { ...camelRow(row), enabled: Boolean(row.enabled) }; }) }));
  app.put("/api/admin/mirrors/:trackerKey", { preHandler: requireAdmin }, async (request, reply) => {
    const params = parse(z.object({ trackerKey: trackerKeySchema }), request.params, reply), input = parse(z.object({ baseUrl: urlSchema, enabled: z.boolean() }), request.body, reply);
    if (!params || !input) return;
    db.prepare("UPDATE tracker_mirrors SET base_url = ?, enabled = ?, updated_at = ? WHERE tracker_key = ?").run(origin(input.baseUrl), input.enabled ? 1 : 0, nowIso(), params.trackerKey);
    return { ok: true };
  });
}
function observationFilter(cutoff: string, query: { trackerKey?: string; operation?: string; outcome?: string }): { where: string; parameters: string[] } {
  const where = ["o.observed_at >= ?"], parameters = [cutoff];
  if (query.trackerKey) { where.push("o.tracker_key = ?"); parameters.push(query.trackerKey); }
  if (query.operation) { where.push("o.operation = ?"); parameters.push(query.operation); }
  if (query.outcome) { where.push("o.outcome = ?"); parameters.push(query.outcome); }
  return { where: where.join(" AND "), parameters };
}
function serializeObservation(value: unknown): Record<string, unknown> {
  const row = value as Record<string, unknown>;
  return { ...camelRow(row), details: jsonObject(row.details as string) || {}, hasCover: nullableBoolean(row.has_cover), hasMagnet: nullableBoolean(row.has_magnet), hasTorrentFile: nullableBoolean(row.has_torrent_file) };
}
function notificationQueue(db: SqliteDatabase, limit: number): Array<Record<string, unknown>> {
  return db.prepare(`SELECT q.id, u.username, q.subscription_id, ${SUBSCRIPTION_NAME_SQL}, q.attempts, q.next_attempt_at, q.last_error, q.created_at,
    CASE WHEN q.lease_until > ? THEN 'sending' ELSE 'pending' END AS status FROM notification_queue q JOIN users u ON u.id = q.user_id
    LEFT JOIN subscriptions s ON s.id = q.subscription_id WHERE q.delivered_at IS NULL ORDER BY q.next_attempt_at LIMIT ?`).all(nowIso(), limit).map(camelRow);
}
function camelRow(value: unknown): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, field]) => [key.replace(/_([a-z])/g, (_, character: string) => character.toUpperCase()), field]));
}
function nullableBoolean(value: unknown): boolean | null { return value === null ? null : Boolean(value); }
