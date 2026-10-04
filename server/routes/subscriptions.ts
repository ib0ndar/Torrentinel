import { z } from "zod";
import { nowIso, type SqliteDatabase } from "../db.js";
import { requireReadyUser } from "../auth.js";
import { trackerRegistry } from "../trackers/index.js";
import { MONITOR_FILTERS, type TrackerKey } from "../types.js";
import { adapterForUserUrl, idParams, jsonArray, jsonObject, ownsCollection, ownsSubscription, parse, trackerKeySchema, urlSchema, type RouteServices } from "./shared.js";

const subscriptionCreateSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("direct"), collectionId: z.string().min(1), url: urlSchema }),
  z.object({ type: z.literal("rule"), collectionId: z.string().min(1), trackerKeys: z.array(trackerKeySchema).min(1),
    requiredTerms: z.array(z.string()).min(1).max(30), ignoredTerms: z.array(z.string()).max(30).default([]) }),
]);
const subscriptionUpdateSchema = z.object({ collectionId: z.string().min(1).optional(), enabled: z.boolean().optional(), url: urlSchema.optional(),
  trackerKeys: z.array(trackerKeySchema).min(1).optional(), requiredTerms: z.array(z.string()).min(1).max(30).optional(), ignoredTerms: z.array(z.string()).max(30).optional() });
const RECENT_CHANGE_ORDER = "COALESCE(s.last_changed_at, s.created_at) DESC, s.created_at DESC, s.rowid DESC";
// Mirrors serializeSubscription's label: rule phrases joined with " + ", else the current title or stored name.
export const LABEL_SQL = `CASE WHEN s.type = 'rule' THEN COALESCE((SELECT GROUP_CONCAT(value, ' + ') FROM json_each(CASE WHEN json_valid(s.required_terms) THEN s.required_terms ELSE '[]' END)), '')
  ELSE COALESCE(NULLIF(TRIM(CASE WHEN json_valid(s.current_snapshot) THEN json_extract(s.current_snapshot, '$.title') END), ''), s.name, '') END`;
const SUBSCRIPTION_ORDER = {
  changed: RECENT_CHANGE_ORDER,
  name: `${LABEL_SQL} = '', sort_text(${LABEL_SQL}), ${RECENT_CHANGE_ORDER}`,
  // Same precedence as the list status: Needs attention, Paused, Learning, then everything else.
  attention: `CASE WHEN s.last_error IS NOT NULL AND s.last_error <> '' THEN 0 WHEN s.enabled = 0 THEN 1 WHEN s.initialized = 0 THEN 2 ELSE 3 END, ${RECENT_CHANGE_ORDER}`,
} as const;

export function registerSubscriptionRoutes({ app, db, scheduler, coverCache }: RouteServices): void {
  app.get("/api/subscriptions", { preHandler: requireReadyUser }, async (request, reply) => {
    const query = parse(z.object({ collectionId: z.string().optional(), view: z.enum(["summary", "detail"]).default("detail"),
      search: z.string().trim().max(200).default(""), filter: z.enum(MONITOR_FILTERS).default("all"), sort: z.enum(["changed", "name", "attention"]).default("changed"),
      page: z.coerce.number().int().min(1).max(1_000_000).optional(), pageSize: z.coerce.number().int().min(1).max(200).optional() }), request.query, reply);
    if (!query || !request.user) return;
    const args: Array<string | number> = [request.user.id];
    const where = ["s.user_id = ?"];
    if (query.collectionId) { where.push("s.collection_id = ?"); args.push(query.collectionId); }
    if (query.filter === "unread") where.push("(s.manual_unread = 1 OR EXISTS (SELECT 1 FROM subscription_events e WHERE e.subscription_id = s.id AND e.read_at IS NULL))");
    if (query.filter === "errors") where.push("s.last_error IS NOT NULL AND s.last_error <> ''");
    if (query.search) {
      where.push(`contains_text(s.name || ' ' || COALESCE(CASE WHEN json_valid(s.current_snapshot) THEN json_extract(s.current_snapshot, '$.title') END, '')
        || ' ' || COALESCE((SELECT GROUP_CONCAT(value, ' ') FROM json_each(CASE WHEN json_valid(s.required_terms) THEN s.required_terms ELSE '[]' END)), '')
        || ' ' || COALESCE((SELECT GROUP_CONCAT(value, ' + ') FROM json_each(CASE WHEN json_valid(s.required_terms) THEN s.required_terms ELSE '[]' END)), '')
        || ' ' || COALESCE((SELECT GROUP_CONCAT(st.tracker_key, ' ') FROM subscription_trackers st WHERE st.subscription_id = s.id), ''), ?) = 1`);
      args.push(query.search);
    }
    // Legacy API callers without a page retain the full-list contract. The UI
    // explicitly requests a page when the user's pagination preference is on.
    const paginated = query.page !== undefined;
    const pageSize = query.pageSize ?? request.user.pageSize;
    const total = (db.prepare(`SELECT COUNT(*) AS count FROM subscriptions s WHERE ${where.join(" AND ")}`).get(...args) as { count: number }).count;
    const pageCount = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(query.page ?? 1, pageCount);
    const rows = db.prepare(`${subscriptionSelect(query.view === "summary")} WHERE ${where.join(" AND ")}
      ORDER BY ${SUBSCRIPTION_ORDER[query.sort]} ${paginated ? "LIMIT ? OFFSET ?" : ""}`)
      .all(...args, ...(paginated ? [pageSize, (page - 1) * pageSize] : [])) as SubscriptionDbRow[];
    return { subscriptions: rows.map(query.view === "summary" ? serializeSubscriptionSummary : serializeSubscription),
      total, page, pageSize: paginated ? pageSize : total, pageCount: paginated ? pageCount : 1 };
  });

  app.post("/api/subscriptions", { preHandler: requireReadyUser }, async (request, reply) => {
    const input = parse(subscriptionCreateSchema, request.body, reply);
    if (!input || !request.user) return;
    if (!ownsCollection(db, input.collectionId, request.user.id)) return reply.code(404).send({ error: "Collection not found" });
    let trackers: TrackerKey[], directUrl: string | null = null;
    if (input.type === "direct") {
      const adapter = adapterForUserUrl(db, request.user.id, input.url);
      if (!adapter) return reply.code(400).send({ error: "The URL does not belong to a supported tracker" });
      if (!adapter.direct) return reply.code(400).send({ error: "This tracker does not support direct subscriptions" });
      trackers = [adapter.manifest.key]; directUrl = input.url;
    } else {
      const unsupported = input.trackerKeys.find((key) => !trackerRegistry.get(key)?.rules);
      if (unsupported) return reply.code(400).send({ error: `${unsupported} does not support rule subscriptions` });
      trackers = [...new Set(input.trackerKeys)];
    }
    const timestamp = nowIso();
    let id = "";
    db.transaction(() => {
      id = nextNumericSubscriptionId(db);
      db.prepare(`INSERT INTO subscriptions (id, user_id, collection_id, type, name, direct_url, required_terms, ignored_terms, created_at, updated_at)
        VALUES (?, ?, ?, ?, '', ?, ?, ?, ?, ?)`).run(id, request.user!.id, input.collectionId, input.type, directUrl,
        JSON.stringify(input.type === "rule" ? normalizeTerms(input.requiredTerms) : []), JSON.stringify(input.type === "rule" ? normalizeTerms(input.ignoredTerms) : []), timestamp, timestamp);
      for (const trackerKey of trackers) {
        db.prepare("INSERT INTO subscription_trackers (subscription_id, tracker_key) VALUES (?, ?)").run(id, trackerKey);
        db.prepare("INSERT INTO subscription_tracker_state (subscription_id, tracker_key) VALUES (?, ?)").run(id, trackerKey);
      }
    })();
    scheduler.queueSubscriptionCheck(id, request.user.id);
    return reply.code(201).send({ subscription: { id, type: input.type, label: input.type === "rule" ? ruleLabel(input.requiredTerms) : "Direct subscription", collectionId: input.collectionId, trackerKeys: trackers } });
  });
  app.get("/api/subscriptions/:id", { preHandler: requireReadyUser }, async (request, reply) => {
    const params = parse(idParams, request.params, reply);
    if (!params || !request.user) return;
    const details = subscriptionDetails(db, params.id, request.user.id);
    if (!details) return reply.code(404).send({ error: "Subscription not found" });
    return details;
  });
  app.post("/api/subscriptions/:id/open", { preHandler: requireReadyUser }, async (request, reply) => {
    const params = parse(idParams, request.params, reply);
    if (!params || !request.user) return;
    const userId = request.user.id;
    const details = db.transaction(() => {
      if (!ownsSubscription(db, params.id, userId)) return;
      markSubscriptionRead(db, params.id, userId);
      return subscriptionDetails(db, params.id, userId);
    })();
    if (!details) return reply.code(404).send({ error: "Subscription not found" });
    return details;
  });
  app.patch("/api/subscriptions/:id", { preHandler: requireReadyUser }, async (request, reply) => {
    const params = parse(idParams, request.params, reply), input = parse(subscriptionUpdateSchema, request.body, reply);
    if (!params || !input || !request.user) return;
    const current = db.prepare("SELECT * FROM subscriptions WHERE id = ? AND user_id = ?").get(params.id, request.user.id) as Record<string, unknown> | undefined;
    if (!current) return reply.code(404).send({ error: "Subscription not found" });
    if (input.collectionId && !ownsCollection(db, input.collectionId, request.user.id)) return reply.code(404).send({ error: "Collection not found" });
    const updates: Record<string, unknown> = { name: current.type === "rule" ? "" : current.name, collection_id: input.collectionId ?? current.collection_id,
      enabled: input.enabled === undefined ? current.enabled : input.enabled ? 1 : 0, updated_at: nowIso() };
    let resetBaseline = false, trackers: TrackerKey[] | undefined;
    if (current.type === "direct" && input.url) {
      const adapter = adapterForUserUrl(db, request.user.id, input.url);
      if (!adapter) return reply.code(400).send({ error: "The URL does not belong to a supported tracker" });
      if (!adapter.direct) return reply.code(400).send({ error: "This tracker does not support direct subscriptions" });
      updates.direct_url = input.url; trackers = [adapter.manifest.key]; resetBaseline = input.url !== current.direct_url;
    }
    if (current.type === "rule") {
      if (input.requiredTerms) { updates.required_terms = JSON.stringify(normalizeTerms(input.requiredTerms)); resetBaseline = true; }
      if (input.ignoredTerms) { updates.ignored_terms = JSON.stringify(normalizeTerms(input.ignoredTerms)); resetBaseline = true; }
      if (input.trackerKeys) {
        const unsupported = input.trackerKeys.find((key) => !trackerRegistry.get(key)?.rules);
        if (unsupported) return reply.code(400).send({ error: `${unsupported} does not support rule subscriptions` });
        trackers = [...new Set(input.trackerKeys)]; resetBaseline = true;
      }
    }
    db.transaction(() => {
      db.prepare(`UPDATE subscriptions SET name = @name, collection_id = @collection_id, enabled = @enabled, updated_at = @updated_at,
        direct_url = COALESCE(@direct_url, direct_url), required_terms = COALESCE(@required_terms, required_terms), ignored_terms = COALESCE(@ignored_terms, ignored_terms),
        initialized = CASE WHEN @reset_baseline = 1 THEN 0 ELSE initialized END,
        current_fingerprint = CASE WHEN @reset_baseline = 1 THEN NULL ELSE current_fingerprint END,
        current_snapshot = CASE WHEN @reset_baseline = 1 THEN NULL ELSE current_snapshot END,
        last_error = CASE WHEN @reset_baseline = 1 THEN NULL ELSE last_error END WHERE id = @id AND user_id = @user_id`).run({ ...updates,
        direct_url: updates.direct_url ?? null, required_terms: updates.required_terms ?? null, ignored_terms: updates.ignored_terms ?? null,
        reset_baseline: resetBaseline ? 1 : 0, id: params.id, user_id: request.user!.id });
      if (trackers) {
        db.prepare("DELETE FROM subscription_trackers WHERE subscription_id = ?").run(params.id);
        db.prepare("DELETE FROM subscription_tracker_state WHERE subscription_id = ?").run(params.id);
        for (const trackerKey of trackers) {
          db.prepare("INSERT INTO subscription_trackers (subscription_id, tracker_key) VALUES (?, ?)").run(params.id, trackerKey);
          db.prepare("INSERT INTO subscription_tracker_state (subscription_id, tracker_key) VALUES (?, ?)").run(params.id, trackerKey);
        }
      }
      if (resetBaseline && current.type === "rule") db.prepare("DELETE FROM rule_matches WHERE subscription_id = ?").run(params.id);
    })();
    if (resetBaseline && current.type === "direct") await coverCache.remove(params.id);
    if (resetBaseline) scheduler.queueSubscriptionCheck(params.id, request.user.id);
    return { ok: true };
  });
  app.delete("/api/subscriptions/:id", { preHandler: requireReadyUser }, async (request, reply) => {
    const params = parse(idParams, request.params, reply);
    if (!params || !request.user) return;
    if (!ownsSubscription(db, params.id, request.user.id)) return reply.code(404).send({ error: "Subscription not found" });
    await coverCache.remove(params.id);
    if (!db.prepare("DELETE FROM subscriptions WHERE id = ? AND user_id = ?").run(params.id, request.user.id).changes) return reply.code(404).send({ error: "Subscription not found" });
    return { ok: true };
  });
  app.post("/api/subscriptions/:id/read", { preHandler: requireReadyUser }, async (request, reply) => {
    const params = parse(idParams, request.params, reply), input = parse(z.object({ read: z.boolean() }), request.body, reply);
    if (!params || !input || !request.user) return;
    if (!ownsSubscription(db, params.id, request.user.id)) return reply.code(404).send({ error: "Subscription not found" });
    db.transaction(() => { if (input.read) markSubscriptionRead(db, params.id, request.user!.id); else db.prepare("UPDATE subscriptions SET manual_unread = 1 WHERE id = ?").run(params.id); })();
    return { ok: true };
  });
  app.post("/api/subscriptions/:id/check", { preHandler: requireReadyUser }, async (request, reply) => {
    const params = parse(idParams, request.params, reply);
    if (!params || !request.user) return;
    if (!ownsSubscription(db, params.id, request.user.id)) return reply.code(404).send({ error: "Subscription not found" });
    await scheduler.checkSubscription(params.id, request.user.id);
    return { ok: true };
  });
}

function subscriptionSelect(summary = false): string {
  const fields = summary ? `s.id, s.collection_id, s.type, s.name, s.direct_url, s.required_terms, s.ignored_terms,
    s.enabled, s.initialized, s.last_checked_at, s.last_changed_at, s.last_error, s.manual_unread, s.created_at, s.updated_at, NULL AS current_snapshot,
    CASE WHEN json_valid(s.current_snapshot) THEN json_extract(s.current_snapshot, '$.title') END AS current_title` : "s.*";
  return `SELECT ${fields}, c.name AS collection_name,
    (SELECT GROUP_CONCAT(st.tracker_key) FROM subscription_trackers st WHERE st.subscription_id = s.id) AS tracker_keys,
    (SELECT COUNT(*) FROM subscription_events e WHERE e.subscription_id = s.id AND e.read_at IS NULL) AS unread_count,
    (SELECT COUNT(*) FROM subscription_events e WHERE e.subscription_id = s.id) AS event_count,
    (SELECT COUNT(*) FROM rule_matches rm WHERE rm.subscription_id = s.id) AS match_count
    FROM subscriptions s JOIN collections c ON c.id = s.collection_id`;
}
function markSubscriptionRead(db: SqliteDatabase, id: string, userId: string): void {
  db.prepare("UPDATE subscription_events SET read_at = ? WHERE subscription_id = ? AND user_id = ? AND read_at IS NULL").run(nowIso(), id, userId);
  db.prepare("UPDATE subscriptions SET manual_unread = 0 WHERE id = ? AND user_id = ?").run(id, userId);
}
function subscriptionDetails(db: SqliteDatabase, id: string, userId: string) {
  const row = db.prepare(`${subscriptionSelect()} WHERE s.id = ? AND s.user_id = ?`).get(id, userId) as SubscriptionDbRow | undefined;
  if (!row) return;
  const events = db.prepare(`SELECT id, kind, summary, payload, created_at, read_at FROM subscription_events WHERE subscription_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT 100`)
    .all(id, userId).map((value) => { const event = value as EventRow; return { id: event.id, kind: event.kind, summary: event.summary, payload: jsonObject(event.payload), createdAt: event.created_at, readAt: event.read_at }; });
  const matches = row.type === "rule" ? db.prepare(`SELECT id, tracker_key, external_id, title, url, magnet, torrent_url, discovered_at FROM rule_matches WHERE subscription_id = ? ORDER BY discovered_at DESC LIMIT 200`)
    .all(id).map((value) => { const match = value as MatchRow; return { id: match.id, trackerKey: match.tracker_key, externalId: match.external_id, title: match.title, url: match.url, magnet: match.magnet, torrentUrl: match.torrent_url, discoveredAt: match.discovered_at }; }) : [];
  return { subscription: serializeSubscription(row), events, matches };
}
function normalizeTerms(terms: string[]): string[] { return [...new Set(terms.map((term) => term.trim()).filter(Boolean))]; }
function ruleLabel(terms: string[]): string { return normalizeTerms(terms).join(" + ") || "Rule subscription"; }
export function subscriptionLabel(type: "direct" | "rule", requiredTerms: string[], title: unknown, name: string): string {
  if (type === "rule") return ruleLabel(requiredTerms);
  return typeof title === "string" && title.trim() ? title : name || "Direct subscription";
}
function nextNumericSubscriptionId(db: SqliteDatabase): string {
  return String((db.prepare(`SELECT COALESCE(MAX(CASE WHEN id <> '' AND id NOT GLOB '*[^0-9]*' THEN CAST(id AS INTEGER) ELSE NULL END), 0) + 1 AS id FROM subscriptions`).get() as { id: number }).id);
}
function serializeSubscription(row: SubscriptionDbRow) {
  const currentSnapshot = jsonObject(row.current_snapshot);
  const requiredTerms = jsonArray(row.required_terms);
  return { id: row.id, collectionId: row.collection_id, collectionName: row.collection_name, type: row.type,
    label: subscriptionLabel(row.type, requiredTerms, row.current_title ?? currentSnapshot?.title, row.name), directUrl: row.direct_url,
    requiredTerms, ignoredTerms: jsonArray(row.ignored_terms), trackerKeys: row.tracker_keys?.split(",").filter(Boolean) || [], enabled: Boolean(row.enabled), initialized: Boolean(row.initialized),
    lastCheckedAt: row.last_checked_at, lastChangedAt: row.last_changed_at, lastError: row.last_error, currentSnapshot,
    isUnread: Boolean(row.manual_unread) || Number(row.unread_count) > 0, unreadCount: Number(row.unread_count), eventCount: Number(row.event_count), matchCount: Number(row.match_count), createdAt: row.created_at, updatedAt: row.updated_at };
}
function serializeSubscriptionSummary(row: SubscriptionDbRow) { const { currentSnapshot: _snapshot, ...summary } = serializeSubscription(row); return summary; }
interface SubscriptionDbRow {
  id: string; collection_id: string; collection_name: string; type: "direct" | "rule"; name: string;
  direct_url: string | null; required_terms: string; ignored_terms: string; tracker_keys: string | null;
  enabled: number; initialized: number; last_checked_at: string | null; last_changed_at: string | null;
  last_error: string | null; current_snapshot: string | null; manual_unread: number; current_title?: unknown;
  unread_count: number; event_count: number; match_count: number; created_at: string; updated_at: string;
}
interface EventRow { id: string; kind: string; summary: string; payload: string; created_at: string; read_at: string | null }
interface MatchRow { id: string; tracker_key: string; external_id: string; title: string; url: string; magnet: string | null; torrent_url: string | null; discovered_at: string }
