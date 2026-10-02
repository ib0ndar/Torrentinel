import { z } from "zod";
import { nanoid } from "nanoid";
import { nowIso } from "../db.js";
import { requireReadyUser } from "../auth.js";
import { idParams, isUniqueError, ownsCollection, parse, type RouteServices } from "./shared.js";
import { REMINDER_SQL } from "./activity.js";

const collectionSchema = z.object({ name: z.string().trim().min(1).max(80) });
export function registerCollectionRoutes({ app, db, coverCache }: RouteServices): void {
  app.get("/api/collections", { preHandler: requireReadyUser }, async (request) => {
    const rows = db.prepare(`SELECT c.id, c.name, c.created_at, c.updated_at, COUNT(s.id) AS subscription_count,
      COALESCE(SUM(CASE WHEN s.manual_unread = 1 OR EXISTS (
        SELECT 1 FROM subscription_events e WHERE e.subscription_id = s.id AND e.read_at IS NULL
      ) THEN 1 ELSE 0 END), 0) AS unread_count,
      COALESCE(SUM((SELECT COUNT(*) FROM subscription_events e WHERE e.subscription_id = s.id AND e.read_at IS NULL)
        + CASE WHEN ${REMINDER_SQL} THEN 1 ELSE 0 END), 0) AS activity_count FROM collections c
      LEFT JOIN subscriptions s ON s.collection_id = c.id WHERE c.user_id = ? GROUP BY c.id ORDER BY c.created_at`).all(request.user!.id);
    return { collections: rows.map((value) => {
      const row = value as Record<string, unknown>;
      return { id: row.id, name: row.name, subscriptionCount: Number(row.subscription_count), unreadCount: Number(row.unread_count), activityCount: Number(row.activity_count), createdAt: row.created_at, updatedAt: row.updated_at };
    }) };
  });
  app.post("/api/collections", { preHandler: requireReadyUser }, async (request, reply) => {
    const input = parse(collectionSchema, request.body, reply);
    if (!input || !request.user) return;
    const timestamp = nowIso(), id = nanoid();
    try { db.prepare("INSERT INTO collections (id, user_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(id, request.user.id, input.name, timestamp, timestamp); }
    catch (error) { if (isUniqueError(error)) return reply.code(409).send({ error: "A collection with this name already exists" }); throw error; }
    return reply.code(201).send({ collection: { id, name: input.name, subscriptionCount: 0, unreadCount: 0, activityCount: 0 } });
  });
  app.patch("/api/collections/:id", { preHandler: requireReadyUser }, async (request, reply) => {
    const params = parse(idParams, request.params, reply), input = parse(collectionSchema, request.body, reply);
    if (!params || !input || !request.user) return;
    try {
      if (!db.prepare("UPDATE collections SET name = ?, updated_at = ? WHERE id = ? AND user_id = ?").run(input.name, nowIso(), params.id, request.user.id).changes)
        return reply.code(404).send({ error: "Collection not found" });
    } catch (error) { if (isUniqueError(error)) return reply.code(409).send({ error: "A collection with this name already exists" }); throw error; }
    return { ok: true };
  });
  app.delete("/api/collections/:id", { preHandler: requireReadyUser }, async (request, reply) => {
    const params = parse(idParams, request.params, reply);
    if (!params || !request.user) return;
    if (!ownsCollection(db, params.id, request.user.id)) return reply.code(404).send({ error: "Collection not found" });
    const subscriptions = db.prepare("SELECT id FROM subscriptions WHERE collection_id = ? AND user_id = ?").all(params.id, request.user.id) as Array<{ id: string }>;
    await Promise.all(subscriptions.map((subscription) => coverCache.remove(subscription.id)));
    if (!db.prepare("DELETE FROM collections WHERE id = ? AND user_id = ?").run(params.id, request.user.id).changes) return reply.code(404).send({ error: "Collection not found" });
    return { ok: true };
  });
}
