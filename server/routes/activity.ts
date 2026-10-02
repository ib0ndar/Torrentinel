import { z } from "zod";
import { nowIso } from "../db.js";
import { requireReadyUser } from "../auth.js";
import { jsonArray, jsonObject, ownsCollection, parse, type RouteServices } from "./shared.js";
import { subscriptionLabel } from "./subscriptions.js";

// A manual "Mark unread" reminder surfaces the subscription's latest change as unread.
const UNREAD_EVENT_SQL = `(e.read_at IS NULL OR (s.manual_unread = 1 AND e.id = (SELECT latest.id FROM subscription_events latest
  WHERE latest.subscription_id = s.id ORDER BY latest.created_at DESC, latest.rowid DESC LIMIT 1)))`;
const SNAPSHOT_FIELDS = ["title", "url", "coverUrl", "magnet", "torrentUrl"] as const;
const RELEASE_FIELDS = ["trackerKey", "title", "url", "magnet", "torrentUrl"] as const;

export function registerActivityRoutes({ app, db }: RouteServices): void {
  app.get("/api/activity", { preHandler: requireReadyUser }, async (request, reply) => {
    const query = parse(z.object({ filter: z.enum(["unread", "all"]).default("unread"),
      page: z.coerce.number().int().min(1).max(1_000_000).default(1), pageSize: z.coerce.number().int().min(1).max(200).optional() }), request.query, reply);
    if (!query || !request.user) return;
    const userId = request.user.id, pageSize = query.pageSize ?? request.user.pageSize;
    const where = `e.user_id = ? AND s.user_id = ?${query.filter === "unread" ? ` AND ${UNREAD_EVENT_SQL}` : ""}`;
    const total = (db.prepare(`SELECT COUNT(*) AS count FROM subscription_events e JOIN subscriptions s ON s.id = e.subscription_id WHERE ${where}`)
      .get(userId, userId) as { count: number }).count;
    const pageCount = Math.max(1, Math.ceil(total / pageSize)), page = Math.min(query.page, pageCount);
    const rows = db.prepare(`SELECT e.id, e.kind, e.summary, e.payload, e.created_at, e.read_at, ${UNREAD_EVENT_SQL} AS is_unread,
      s.id AS subscription_id, s.type, s.name, s.direct_url, s.required_terms, s.ignored_terms,
      CASE WHEN json_valid(s.current_snapshot) THEN json_extract(s.current_snapshot, '$.title') END AS current_title,
      (SELECT GROUP_CONCAT(st.tracker_key) FROM subscription_trackers st WHERE st.subscription_id = s.id) AS tracker_keys,
      c.id AS collection_id, c.name AS collection_name
      FROM subscription_events e JOIN subscriptions s ON s.id = e.subscription_id JOIN collections c ON c.id = s.collection_id
      WHERE ${where} ORDER BY e.created_at DESC, e.rowid DESC LIMIT ? OFFSET ?`).all(userId, userId, pageSize, (page - 1) * pageSize) as ActivityRow[];
    return { events: rows.map(serializeActivity), total, page, pageSize, pageCount };
  });

  // Marks every change read and clears manual reminders, for one collection or all of them.
  app.post("/api/activity/read", { preHandler: requireReadyUser }, async (request, reply) => {
    const input = parse(z.object({ collectionId: z.string().min(1).max(100).optional() }).default({}), request.body ?? {}, reply);
    if (!input || !request.user) return;
    const userId = request.user.id, collectionId = input.collectionId;
    if (collectionId && !ownsCollection(db, collectionId, userId)) return reply.code(404).send({ error: "Collection not found" });
    const scope = collectionId ? [userId, collectionId] : [userId], inCollection = collectionId ? " AND collection_id = ?" : "";
    return db.transaction(() => {
      const subscriptions = (db.prepare(`SELECT COUNT(*) AS count FROM subscriptions s WHERE s.user_id = ?${collectionId ? " AND s.collection_id = ?" : ""}
        AND (s.manual_unread = 1 OR EXISTS (SELECT 1 FROM subscription_events e WHERE e.subscription_id = s.id AND e.read_at IS NULL))`).get(...scope) as { count: number }).count;
      const events = db.prepare(`UPDATE subscription_events SET read_at = ? WHERE user_id = ? AND read_at IS NULL
        ${collectionId ? "AND subscription_id IN (SELECT id FROM subscriptions WHERE user_id = ? AND collection_id = ?)" : ""}`)
        .run(nowIso(), userId, ...(collectionId ? scope : [])).changes;
      db.prepare(`UPDATE subscriptions SET manual_unread = 0 WHERE user_id = ?${inCollection} AND manual_unread = 1`).run(...scope);
      return { ok: true, subscriptions, events };
    })();
  });
}

function pick(value: unknown, fields: readonly string[]): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return;
  const source = value as Record<string, unknown>;
  return Object.fromEntries(fields.filter((field) => source[field] !== undefined && source[field] !== null).map((field) => [field, source[field]]));
}
// The list only needs what the summary shows; snapshot metadata can be large.
function compactPayload(payload: Record<string, unknown> | null) {
  if (!payload) return null;
  return { changes: Array.isArray(payload.changes) ? payload.changes.filter((value) => typeof value === "string") : undefined,
    previous: pick(payload.previous, SNAPSHOT_FIELDS), current: pick(payload.current, SNAPSHOT_FIELDS),
    releases: Array.isArray(payload.releases) ? payload.releases.map((release) => pick(release, RELEASE_FIELDS)).filter(Boolean) : undefined };
}
function serializeActivity(row: ActivityRow) {
  const requiredTerms = jsonArray(row.required_terms);
  return { id: row.id, kind: row.kind, summary: row.summary, payload: compactPayload(jsonObject(row.payload)), createdAt: row.created_at, readAt: row.read_at, isUnread: Boolean(row.is_unread),
    subscription: { id: row.subscription_id, type: row.type, label: subscriptionLabel(row.type, requiredTerms, row.current_title, row.name), directUrl: row.direct_url,
      requiredTerms, ignoredTerms: jsonArray(row.ignored_terms), trackerKeys: row.tracker_keys?.split(",").filter(Boolean) || [] },
    collection: { id: row.collection_id, name: row.collection_name } };
}
interface ActivityRow {
  id: string; kind: string; summary: string; payload: string; created_at: string; read_at: string | null; is_unread: number;
  subscription_id: string; type: "direct" | "rule"; name: string; direct_url: string | null; required_terms: string; ignored_terms: string;
  current_title: unknown; tracker_keys: string | null; collection_id: string; collection_name: string;
}
