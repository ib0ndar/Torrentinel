import type { FastifyInstance } from "fastify";
import { compare, hash } from "bcryptjs";
import { nanoid } from "nanoid";
import { z } from "zod";
import type { SqliteDatabase } from "./db.js";
import { nowIso } from "./db.js";
import {
  createSession,
  destroySession,
  requireAdmin,
  requireReadyUser,
  requireUser,
} from "./auth.js";
import {
  MAX_POLL_INTERVAL_MINUTES,
  MIN_POLL_INTERVAL_MINUTES,
  type Scheduler,
} from "./scheduler.js";
import type { TelegramService } from "./telegram.js";
import { adapterForUrl, listTrackers, trackerRegistry } from "./trackers/index.js";
import { TRACKER_KEYS, type TrackerKey } from "./types.js";
import {
  readTrackerCredentials,
  writeTrackerCredentials,
  type SecretVault,
} from "./secrets.js";
import {
  DIAGNOSTIC_RETENTION_HOURS,
  diagnosticCutoffIso,
  pruneDiagnostics,
} from "./diagnostics.js";

const credentialsSchema = z.object({
  username: z.string().trim().min(1).max(80),
  password: z.string().min(1).max(500),
});

const collectionSchema = z.object({ name: z.string().trim().min(1).max(80) });
const trackerKeySchema = z.enum(TRACKER_KEYS);
const urlSchema = z.string().url().refine((value) => ["http:", "https:"].includes(new URL(value).protocol), {
  message: "Only HTTP and HTTPS URLs are supported",
});
const infoHashSchema = z.string().regex(/^(?:[a-f\d]{40}|[a-z2-7]{32})$/i);

export function registerRoutes(
  app: FastifyInstance,
  db: SqliteDatabase,
  scheduler: Scheduler,
  telegram: TelegramService,
  vault: SecretVault,
): void {
  app.get("/api/health", async () => ({
    status: "ok",
    database: "ready",
    scheduler: scheduler.status(),
    telegramConfigured: telegram.configuredCount() > 0,
  }));

  app.get("/magnet/:infoHash", async (request, reply) => {
    const params = parse(z.object({ infoHash: infoHashSchema }), request.params, reply);
    if (!params) return;
    return reply.code(302)
      .header("location", `magnet:?xt=urn:btih:${params.infoHash.toLocaleUpperCase("en-US")}`)
      .send();
  });

  app.post("/api/auth/login", async (request, reply) => {
    const input = parse(credentialsSchema, request.body, reply);
    if (!input) return;
    const row = db.prepare(`
      SELECT id, username, password_hash, is_admin, disabled, must_change_password
      FROM users WHERE username = ?
    `).get(input.username) as UserDbRow | undefined;
    if (!row || row.disabled || !(await compare(input.password, row.password_hash))) {
      return reply.code(401).send({ error: "Invalid username or password" });
    }
    createSession(db, reply, row.id);
    return { user: serializeUser(row) };
  });

  app.post("/api/auth/logout", { preHandler: requireUser }, async (request, reply) => {
    destroySession(db, request, reply);
    return { ok: true };
  });

  app.get("/api/auth/me", { preHandler: requireUser }, async (request) => ({ user: request.user }));

  app.post("/api/auth/change-password", { preHandler: requireUser }, async (request, reply) => {
    const input = parse(z.object({
      currentPassword: z.string().min(1).max(500),
      newPassword: z.string().min(8).max(500),
    }), request.body, reply);
    if (!input || !request.user) return;
    const row = db.prepare("SELECT password_hash FROM users WHERE id = ?").get(request.user.id) as
      | { password_hash: string }
      | undefined;
    if (!row || !(await compare(input.currentPassword, row.password_hash))) {
      return reply.code(400).send({ error: "Current password is incorrect" });
    }
    const timestamp = nowIso();
    db.prepare(`
      UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?
    `).run(await hash(input.newPassword, 12), timestamp, request.user.id);
    request.user.mustChangePassword = false;
    return { user: request.user };
  });

  app.get("/api/trackers", { preHandler: requireReadyUser }, async (request) => {
    const rows = resolvedMirrors(db, request.user!.id);
    return {
      trackers: listTrackers().map((tracker) => {
        const mirror = rows.find((row) => row.tracker_key === tracker.key)!;
        const credentials = readTrackerCredentials(db, vault, request.user!.id, tracker.key);
        return {
          ...tracker,
          baseUrl: mirror.base_url,
          globalBaseUrl: mirror.global_base_url,
          hasOverride: Boolean(mirror.user_base_url),
          enabled: Boolean(mirror.enabled),
          credentialsConfigured: Boolean(credentials),
          username: credentials?.username,
        };
      }),
    };
  });

  app.put("/api/trackers/:trackerKey/settings", { preHandler: requireReadyUser }, async (request, reply) => {
    const params = parse(z.object({ trackerKey: trackerKeySchema }), request.params, reply);
    const input = parse(z.object({
      baseUrl: urlSchema.nullable().optional(),
      username: z.string().trim().max(80).optional(),
      password: z.string().max(500).optional(),
      clearCredentials: z.boolean().default(false),
    }), request.body, reply);
    if (!params || !input || !request.user) return;
    const userId = request.user.id;
    const timestamp = nowIso();
    let credentials: { username: string; password: string } | undefined;
    if (!input.clearCredentials && (input.username !== undefined || input.password !== undefined)) {
      const existing = readTrackerCredentials(db, vault, userId, params.trackerKey);
      const username = input.username === undefined ? existing?.username || "" : input.username;
      const password = input.password || existing?.password || "";
      if (!username || !password) {
        return reply.code(400).send({ error: "Both username and password are required to save tracker credentials" });
      }
      credentials = { username, password };
    }

    db.transaction(() => {
      if (input.baseUrl !== undefined) {
        if (!input.baseUrl) {
          db.prepare("DELETE FROM user_tracker_mirrors WHERE user_id = ? AND tracker_key = ?")
            .run(userId, params.trackerKey);
        } else {
          db.prepare(`
            INSERT INTO user_tracker_mirrors (user_id, tracker_key, base_url, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(user_id, tracker_key) DO UPDATE SET
              base_url = excluded.base_url, updated_at = excluded.updated_at
          `).run(userId, params.trackerKey, origin(input.baseUrl), timestamp);
        }
      }
      if (input.clearCredentials) {
        db.prepare("DELETE FROM user_tracker_credentials WHERE user_id = ? AND tracker_key = ?")
          .run(userId, params.trackerKey);
      } else if (credentials) {
        writeTrackerCredentials(db, vault, userId, params.trackerKey, credentials);
      }
    })();
    return { ok: true };
  });

  app.put("/api/trackers/:trackerKey/mirror", { preHandler: requireReadyUser }, async (request, reply) => {
    const params = parse(z.object({ trackerKey: trackerKeySchema }), request.params, reply);
    const input = parse(z.object({ baseUrl: urlSchema.nullable() }), request.body, reply);
    if (!params || !input || !request.user) return;
    const timestamp = nowIso();
    if (!input.baseUrl) {
      db.prepare("DELETE FROM user_tracker_mirrors WHERE user_id = ? AND tracker_key = ?")
        .run(request.user.id, params.trackerKey);
    } else {
      db.prepare(`
        INSERT INTO user_tracker_mirrors (user_id, tracker_key, base_url, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(user_id, tracker_key) DO UPDATE SET
          base_url = excluded.base_url, updated_at = excluded.updated_at
      `).run(request.user.id, params.trackerKey, origin(input.baseUrl), timestamp);
    }
    return { ok: true };
  });

  app.get("/api/collections", { preHandler: requireReadyUser }, async (request) => {
    const rows = db.prepare(`
      SELECT c.id, c.name, c.created_at, c.updated_at,
             COUNT(s.id) AS subscription_count,
             COALESCE(SUM(CASE WHEN s.is_updated = 1 THEN 1 ELSE 0 END), 0) AS updated_count,
             COALESCE(SUM(CASE WHEN s.manual_unread = 1 OR EXISTS (
               SELECT 1 FROM subscription_events e WHERE e.subscription_id = s.id AND e.read_at IS NULL
             ) THEN 1 ELSE 0 END), 0) AS unread_count
      FROM collections c
      LEFT JOIN subscriptions s ON s.collection_id = c.id
      WHERE c.user_id = ?
      GROUP BY c.id
      ORDER BY c.created_at
    `).all(request.user!.id);
    return { collections: rows.map(serializeCollection) };
  });

  app.post("/api/collections", { preHandler: requireReadyUser }, async (request, reply) => {
    const input = parse(collectionSchema, request.body, reply);
    if (!input || !request.user) return;
    const timestamp = nowIso();
    const id = nanoid();
    try {
      db.prepare(`
        INSERT INTO collections (id, user_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
      `).run(id, request.user.id, input.name, timestamp, timestamp);
    } catch (error) {
      if (isUniqueError(error)) return reply.code(409).send({ error: "A collection with this name already exists" });
      throw error;
    }
    return reply.code(201).send({ collection: { id, name: input.name, subscriptionCount: 0, unreadCount: 0, updatedCount: 0 } });
  });

  app.patch("/api/collections/:id", { preHandler: requireReadyUser }, async (request, reply) => {
    const params = parse(idParams, request.params, reply);
    const input = parse(collectionSchema, request.body, reply);
    if (!params || !input || !request.user) return;
    try {
      const result = db.prepare("UPDATE collections SET name = ?, updated_at = ? WHERE id = ? AND user_id = ?")
        .run(input.name, nowIso(), params.id, request.user.id);
      if (!result.changes) return reply.code(404).send({ error: "Collection not found" });
    } catch (error) {
      if (isUniqueError(error)) return reply.code(409).send({ error: "A collection with this name already exists" });
      throw error;
    }
    return { ok: true };
  });

  app.delete("/api/collections/:id", { preHandler: requireReadyUser }, async (request, reply) => {
    const params = parse(idParams, request.params, reply);
    if (!params || !request.user) return;
    const result = db.prepare("DELETE FROM collections WHERE id = ? AND user_id = ?")
      .run(params.id, request.user.id);
    if (!result.changes) return reply.code(404).send({ error: "Collection not found" });
    return { ok: true };
  });

  app.get("/api/subscriptions", { preHandler: requireReadyUser }, async (request, reply) => {
    const query = parse(z.object({ collectionId: z.string().optional() }), request.query, reply);
    if (!query || !request.user) return;
    const args: unknown[] = [request.user.id];
    let collectionFilter = "";
    if (query.collectionId) {
      collectionFilter = "AND s.collection_id = ?";
      args.push(query.collectionId);
    }
    const rows = db.prepare(`${subscriptionSelect()} WHERE s.user_id = ? ${collectionFilter}
      ORDER BY COALESCE(s.last_changed_at, s.created_at) DESC, s.created_at DESC, s.rowid DESC`)
      .all(...args) as SubscriptionDbRow[];
    return { subscriptions: rows.map(serializeSubscription) };
  });

  app.post("/api/subscriptions", { preHandler: requireReadyUser }, async (request, reply) => {
    const input = parse(subscriptionCreateSchema, request.body, reply);
    if (!input || !request.user) return;
    if (!ownsCollection(db, input.collectionId, request.user.id)) {
      return reply.code(404).send({ error: "Collection not found" });
    }

    let trackers: TrackerKey[];
    let directUrl: string | null = null;
    let name = "";
    if (input.type === "direct") {
      const adapter = adapterForUserUrl(db, request.user.id, input.url);
      if (!adapter) return reply.code(400).send({ error: "The URL does not belong to a supported tracker" });
      if (!adapter.direct) return reply.code(400).send({ error: "This tracker does not support direct subscriptions" });
      trackers = [adapter.manifest.key];
      directUrl = input.url;
      name = input.name?.trim() || "";
    } else {
      const unsupported = input.trackerKeys.find((key) => !trackerRegistry.get(key)?.rules);
      if (unsupported) return reply.code(400).send({ error: `${unsupported} does not support rule subscriptions` });
      trackers = input.trackerKeys;
      name = "";
    }

    const timestamp = nowIso();
    let id = "";
    db.transaction(() => {
      id = nextNumericSubscriptionId(db);
      db.prepare(`
        INSERT INTO subscriptions (
          id, user_id, collection_id, type, name, direct_url, required_terms, ignored_terms,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, request.user!.id, input.collectionId, input.type, name, directUrl,
        JSON.stringify(input.type === "rule" ? normalizeTerms(input.requiredTerms) : []),
        JSON.stringify(input.type === "rule" ? normalizeTerms(input.ignoredTerms) : []),
        timestamp, timestamp,
      );
      for (const trackerKey of trackers) {
        db.prepare("INSERT INTO subscription_trackers (subscription_id, tracker_key) VALUES (?, ?)")
          .run(id, trackerKey);
        db.prepare(`
          INSERT INTO subscription_tracker_state (subscription_id, tracker_key) VALUES (?, ?)
        `).run(id, trackerKey);
      }
    })();

    setTimeout(() => void scheduler.checkSubscription(id, request.user!.id), 50);
    return reply.code(201).send({
      subscription: {
        id,
        type: input.type,
        label: input.type === "rule" ? ruleLabel(input.requiredTerms) : name || "Direct subscription",
        collectionId: input.collectionId,
        trackerKeys: trackers,
      },
    });
  });

  app.get("/api/subscriptions/:id", { preHandler: requireReadyUser }, async (request, reply) => {
    const params = parse(idParams, request.params, reply);
    if (!params || !request.user) return;
    const row = db.prepare(`${subscriptionSelect()} WHERE s.id = ? AND s.user_id = ?`)
      .get(params.id, request.user.id) as SubscriptionDbRow | undefined;
    if (!row) return reply.code(404).send({ error: "Subscription not found" });
    const events = db.prepare(`
      SELECT id, kind, summary, payload, created_at, read_at
      FROM subscription_events WHERE subscription_id = ? AND user_id = ?
      ORDER BY created_at DESC LIMIT 100
    `).all(params.id, request.user.id).map((event) => serializeEvent(event as EventRow));
    const matches = row.type === "rule" ? db.prepare(`
      SELECT id, tracker_key, external_id, title, url, magnet, torrent_url, discovered_at
      FROM rule_matches WHERE subscription_id = ? ORDER BY discovered_at DESC LIMIT 200
    `).all(params.id).map((match) => serializeMatch(match as MatchRow)) : [];
    return { subscription: serializeSubscription(row), events, matches };
  });

  app.patch("/api/subscriptions/:id", { preHandler: requireReadyUser }, async (request, reply) => {
    const params = parse(idParams, request.params, reply);
    const input = parse(subscriptionUpdateSchema, request.body, reply);
    if (!params || !input || !request.user) return;
    const current = db.prepare("SELECT * FROM subscriptions WHERE id = ? AND user_id = ?")
      .get(params.id, request.user.id) as Record<string, unknown> | undefined;
    if (!current) return reply.code(404).send({ error: "Subscription not found" });
    if (input.collectionId && !ownsCollection(db, input.collectionId, request.user.id)) {
      return reply.code(404).send({ error: "Collection not found" });
    }

    const updates: Record<string, unknown> = {
      name: current.type === "rule" ? "" : input.name ?? current.name,
      collection_id: input.collectionId ?? current.collection_id,
      enabled: input.enabled === undefined ? current.enabled : input.enabled ? 1 : 0,
      updated_at: nowIso(),
    };
    let resetBaseline = false;
    let trackers: TrackerKey[] | undefined;
    if (current.type === "direct" && input.url) {
      const adapter = adapterForUserUrl(db, request.user.id, input.url);
      if (!adapter) return reply.code(400).send({ error: "The URL does not belong to a supported tracker" });
      updates.direct_url = input.url;
      if (!adapter.direct) return reply.code(400).send({ error: "This tracker does not support direct subscriptions" });
      trackers = [adapter.manifest.key];
      resetBaseline = input.url !== current.direct_url;
    }
    if (current.type === "rule") {
      if (input.requiredTerms) {
        updates.required_terms = JSON.stringify(normalizeTerms(input.requiredTerms));
        resetBaseline = true;
      }
      if (input.ignoredTerms) {
        updates.ignored_terms = JSON.stringify(normalizeTerms(input.ignoredTerms));
        resetBaseline = true;
      }
      if (input.trackerKeys) {
        const unsupported = input.trackerKeys.find((key) => !trackerRegistry.get(key)?.rules);
        if (unsupported) return reply.code(400).send({ error: `${unsupported} does not support rule subscriptions` });
        trackers = input.trackerKeys;
        resetBaseline = true;
      }
    }

    db.transaction(() => {
      db.prepare(`
        UPDATE subscriptions SET name = @name, collection_id = @collection_id,
          enabled = @enabled, updated_at = @updated_at,
          direct_url = COALESCE(@direct_url, direct_url),
          required_terms = COALESCE(@required_terms, required_terms),
          ignored_terms = COALESCE(@ignored_terms, ignored_terms),
          initialized = CASE WHEN @reset_baseline = 1 THEN 0 ELSE initialized END,
          current_fingerprint = CASE WHEN @reset_baseline = 1 THEN NULL ELSE current_fingerprint END,
          current_snapshot = CASE WHEN @reset_baseline = 1 THEN NULL ELSE current_snapshot END,
          last_error = CASE WHEN @reset_baseline = 1 THEN NULL ELSE last_error END
        WHERE id = @id AND user_id = @user_id
      `).run({
        ...updates,
        direct_url: updates.direct_url ?? null,
        required_terms: updates.required_terms ?? null,
        ignored_terms: updates.ignored_terms ?? null,
        reset_baseline: resetBaseline ? 1 : 0,
        id: params.id,
        user_id: request.user!.id,
      });
      if (trackers) {
        db.prepare("DELETE FROM subscription_trackers WHERE subscription_id = ?").run(params.id);
        db.prepare("DELETE FROM subscription_tracker_state WHERE subscription_id = ?").run(params.id);
        for (const trackerKey of trackers) {
          db.prepare("INSERT INTO subscription_trackers (subscription_id, tracker_key) VALUES (?, ?)")
            .run(params.id, trackerKey);
          db.prepare("INSERT INTO subscription_tracker_state (subscription_id, tracker_key) VALUES (?, ?)")
            .run(params.id, trackerKey);
        }
      }
      if (resetBaseline && current.type === "rule") {
        db.prepare("DELETE FROM rule_matches WHERE subscription_id = ?").run(params.id);
      }
    })();
    if (resetBaseline) setTimeout(() => void scheduler.checkSubscription(params.id, request.user!.id), 50);
    return { ok: true };
  });

  app.delete("/api/subscriptions/:id", { preHandler: requireReadyUser }, async (request, reply) => {
    const params = parse(idParams, request.params, reply);
    if (!params || !request.user) return;
    const result = db.prepare("DELETE FROM subscriptions WHERE id = ? AND user_id = ?")
      .run(params.id, request.user.id);
    if (!result.changes) return reply.code(404).send({ error: "Subscription not found" });
    return { ok: true };
  });

  app.post("/api/subscriptions/:id/read", { preHandler: requireReadyUser }, async (request, reply) => {
    const params = parse(idParams, request.params, reply);
    const input = parse(z.object({ read: z.boolean() }), request.body, reply);
    if (!params || !input || !request.user) return;
    if (!ownsSubscription(db, params.id, request.user.id)) return reply.code(404).send({ error: "Subscription not found" });
    const timestamp = nowIso();
    db.transaction(() => {
      if (input.read) {
        db.prepare("UPDATE subscription_events SET read_at = COALESCE(read_at, ?) WHERE subscription_id = ? AND user_id = ?")
          .run(timestamp, params.id, request.user!.id);
        db.prepare("UPDATE subscriptions SET manual_unread = 0 WHERE id = ?").run(params.id);
      } else {
        db.prepare("UPDATE subscriptions SET manual_unread = 1 WHERE id = ?").run(params.id);
      }
    })();
    return { ok: true };
  });

  app.post("/api/subscriptions/:id/viewed", { preHandler: requireReadyUser }, async (request, reply) => {
    const params = parse(idParams, request.params, reply);
    if (!params || !request.user) return;
    const result = db.prepare(`
      UPDATE subscriptions SET is_updated = 0, last_viewed_at = ? WHERE id = ? AND user_id = ?
    `).run(nowIso(), params.id, request.user.id);
    if (!result.changes) return reply.code(404).send({ error: "Subscription not found" });
    return { ok: true };
  });

  app.post("/api/subscriptions/:id/check", { preHandler: requireReadyUser }, async (request, reply) => {
    const params = parse(idParams, request.params, reply);
    if (!params || !request.user) return;
    if (!ownsSubscription(db, params.id, request.user.id)) return reply.code(404).send({ error: "Subscription not found" });
    await scheduler.checkSubscription(params.id, request.user.id);
    return { ok: true };
  });

  app.get("/api/telegram", { preHandler: requireReadyUser }, async (request) => ({
    telegram: telegram.statusForUser(request.user!.id),
  }));

  app.post("/api/telegram/bot", { preHandler: requireReadyUser }, async (request, reply) => {
    const input = parse(z.object({ token: z.string().trim().min(20).max(200) }), request.body, reply);
    if (!input || !request.user) return;
    return { telegram: await telegram.configureBot(request.user.id, input.token) };
  });

  app.delete("/api/telegram/bot", { preHandler: requireReadyUser }, async (request) => {
    await telegram.removeBot(request.user!.id);
    return { ok: true };
  });

  app.post("/api/telegram/link-code", { preHandler: requireReadyUser }, async (request, reply) => {
    if (!telegram.statusForUser(request.user!.id).configured) return reply.code(503).send({ error: "Telegram bot is not configured" });
    return { link: telegram.createLink(request.user!.id) };
  });

  app.delete("/api/telegram", { preHandler: requireReadyUser }, async (request) => {
    telegram.unlink(request.user!.id);
    return { ok: true };
  });

  app.get("/api/system/status", { preHandler: requireReadyUser }, async () => ({
    scheduler: scheduler.status(),
    intervalMinutes: scheduler.pollIntervalMinutes(),
  }));

  app.post("/api/system/poll", { preHandler: requireAdmin }, async () => ({ scheduler: await scheduler.run("admin") }));

  app.put("/api/admin/settings/poll-interval", { preHandler: requireAdmin }, async (request, reply) => {
    const input = parse(z.object({
      minutes: z.number().int().min(MIN_POLL_INTERVAL_MINUTES).max(MAX_POLL_INTERVAL_MINUTES),
    }), request.body, reply);
    if (!input) return;
    const schedulerStatus = scheduler.setPollIntervalMinutes(input.minutes);
    return { intervalMinutes: scheduler.pollIntervalMinutes(), scheduler: schedulerStatus };
  });

  registerAdminRoutes(app, db);
}

function registerAdminRoutes(app: FastifyInstance, db: SqliteDatabase): void {
  app.get("/api/admin/diagnostics", { preHandler: requireAdmin }, async (request, reply) => {
    const query = parse(z.object({
      trackerKey: trackerKeySchema.optional(),
      operation: z.enum(["direct", "rule-discovery", "rule-enrichment"]).optional(),
      outcome: z.string().trim().min(1).max(40).optional(),
      limit: z.coerce.number().int().min(1).max(250).default(100),
    }), request.query, reply);
    if (!query) return;

    pruneDiagnostics(db);
    const cutoff = diagnosticCutoffIso();
    const where = ["o.observed_at >= ?"];
    const parameters: Array<string | number> = [cutoff];
    if (query.trackerKey) {
      where.push("o.tracker_key = ?");
      parameters.push(query.trackerKey);
    }
    if (query.operation) {
      where.push("o.operation = ?");
      parameters.push(query.operation);
    }
    if (query.outcome) {
      where.push("o.outcome = ?");
      parameters.push(query.outcome);
    }
    parameters.push(query.limit);

    const observations = db.prepare(`
      SELECT o.*, u.username, s.name AS subscription_name
      FROM tracker_observations o
      JOIN users u ON u.id = o.user_id
      LEFT JOIN subscriptions s ON s.id = o.subscription_id
      WHERE ${where.join(" AND ")}
      ORDER BY o.observed_at DESC
      LIMIT ?
    `).all(...parameters) as DiagnosticObservationRow[];
    const runs = db.prepare(`
      SELECT id, trigger, started_at, finished_at, checked, changed, errors, duration_ms
      FROM scheduler_runs
      WHERE COALESCE(finished_at, started_at) >= ?
      ORDER BY started_at DESC
      LIMIT 20
    `).all(cutoff) as DiagnosticRunRow[];
    return {
      retentionHours: DIAGNOSTIC_RETENTION_HOURS,
      generatedAt: nowIso(),
      observations: observations.map(serializeDiagnosticObservation),
      runs: runs.map(serializeDiagnosticRun),
    };
  });

  app.get("/api/admin/users", { preHandler: requireAdmin }, async () => {
    const users = db.prepare(`
      SELECT u.id, u.username, u.is_admin, u.disabled, u.must_change_password, u.created_at,
             COUNT(DISTINCT c.id) AS collection_count,
             COUNT(DISTINCT s.id) AS subscription_count
      FROM users u
      LEFT JOIN collections c ON c.user_id = u.id
      LEFT JOIN subscriptions s ON s.user_id = u.id
      GROUP BY u.id ORDER BY u.created_at
    `).all();
    return { users: users.map((row) => serializeAdminUser(row as AdminUserRow)) };
  });

  app.post("/api/admin/users", { preHandler: requireAdmin }, async (request, reply) => {
    const input = parse(z.object({
      username: z.string().trim().min(1).max(80),
      password: z.string().min(8).max(500),
      isAdmin: z.boolean().default(false),
    }), request.body, reply);
    if (!input) return;
    const id = nanoid();
    const timestamp = nowIso();
    const passwordHash = await hash(input.password, 12);
    try {
      db.transaction(() => {
        db.prepare(`
          INSERT INTO users
            (id, username, password_hash, is_admin, must_change_password, created_at, updated_at)
          VALUES (?, ?, ?, ?, 1, ?, ?)
        `).run(id, input.username, passwordHash, input.isAdmin ? 1 : 0, timestamp, timestamp);
        db.prepare(`
          INSERT INTO collections (id, user_id, name, created_at, updated_at)
          VALUES (?, ?, 'Inbox', ?, ?)
        `).run(nanoid(), id, timestamp, timestamp);
      })();
    } catch (error) {
      if (isUniqueError(error)) return reply.code(409).send({ error: "Username already exists" });
      throw error;
    }
    return reply.code(201).send({ user: { id, username: input.username, isAdmin: input.isAdmin, mustChangePassword: true } });
  });

  app.patch("/api/admin/users/:id", { preHandler: requireAdmin }, async (request, reply) => {
    const params = parse(idParams, request.params, reply);
    const input = parse(z.object({ disabled: z.boolean().optional(), isAdmin: z.boolean().optional() }), request.body, reply);
    if (!params || !input || !request.user) return;
    if (params.id === request.user.id && (input.disabled || input.isAdmin === false)) {
      return reply.code(400).send({ error: "You cannot disable or demote your current account" });
    }
    const current = db.prepare("SELECT disabled, is_admin FROM users WHERE id = ?").get(params.id) as
      | { disabled: number; is_admin: number }
      | undefined;
    if (!current) return reply.code(404).send({ error: "User not found" });
    db.prepare("UPDATE users SET disabled = ?, is_admin = ?, updated_at = ? WHERE id = ?")
      .run(input.disabled === undefined ? current.disabled : input.disabled ? 1 : 0,
        input.isAdmin === undefined ? current.is_admin : input.isAdmin ? 1 : 0,
        nowIso(), params.id);
    if (input.disabled) db.prepare("DELETE FROM sessions WHERE user_id = ?").run(params.id);
    return { ok: true };
  });

  app.post("/api/admin/users/:id/reset-password", { preHandler: requireAdmin }, async (request, reply) => {
    const params = parse(idParams, request.params, reply);
    const input = parse(z.object({ password: z.string().min(8).max(500) }), request.body, reply);
    if (!params || !input) return;
    const result = db.prepare(`
      UPDATE users SET password_hash = ?, must_change_password = 1, updated_at = ? WHERE id = ?
    `).run(await hash(input.password, 12), nowIso(), params.id);
    if (!result.changes) return reply.code(404).send({ error: "User not found" });
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(params.id);
    return { ok: true };
  });

  app.get("/api/admin/mirrors", { preHandler: requireAdmin }, async () => ({
    mirrors: db.prepare("SELECT tracker_key, display_name, base_url, enabled, updated_at FROM tracker_mirrors ORDER BY display_name").all()
      .map((row) => serializeAdminMirror(row as AdminMirrorRow)),
  }));

  app.put("/api/admin/mirrors/:trackerKey", { preHandler: requireAdmin }, async (request, reply) => {
    const params = parse(z.object({ trackerKey: trackerKeySchema }), request.params, reply);
    const input = parse(z.object({ baseUrl: urlSchema, enabled: z.boolean() }), request.body, reply);
    if (!params || !input) return;
    db.prepare("UPDATE tracker_mirrors SET base_url = ?, enabled = ?, updated_at = ? WHERE tracker_key = ?")
      .run(origin(input.baseUrl), input.enabled ? 1 : 0, nowIso(), params.trackerKey);
    return { ok: true };
  });
}

const idParams = z.object({ id: z.string().min(1).max(100) });
const subscriptionCreateSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("direct"),
    collectionId: z.string().min(1),
    name: z.string().trim().max(160).optional(),
    url: urlSchema,
  }),
  z.object({
    type: z.literal("rule"),
    collectionId: z.string().min(1),
    trackerKeys: z.array(trackerKeySchema).min(1),
    requiredTerms: z.array(z.string()).min(1).max(30),
    ignoredTerms: z.array(z.string()).max(30).default([]),
  }),
]);
const subscriptionUpdateSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  collectionId: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  url: urlSchema.optional(),
  trackerKeys: z.array(trackerKeySchema).min(1).optional(),
  requiredTerms: z.array(z.string()).min(1).max(30).optional(),
  ignoredTerms: z.array(z.string()).max(30).optional(),
});

function subscriptionSelect(): string {
  return `
    SELECT s.*, c.name AS collection_name,
      (SELECT GROUP_CONCAT(st.tracker_key) FROM subscription_trackers st WHERE st.subscription_id = s.id) AS tracker_keys,
      (SELECT COUNT(*) FROM subscription_events e WHERE e.subscription_id = s.id AND e.read_at IS NULL) AS unread_count,
      (SELECT COUNT(*) FROM subscription_events e WHERE e.subscription_id = s.id) AS event_count,
      (SELECT COUNT(*) FROM rule_matches rm WHERE rm.subscription_id = s.id) AS match_count
    FROM subscriptions s JOIN collections c ON c.id = s.collection_id
  `;
}

function parse<T>(schema: z.ZodType<T>, value: unknown, reply: { code: (status: number) => { send: (payload: unknown) => unknown } }): T | undefined {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  void reply.code(400).send({ error: "Invalid request", details: z.flattenError(result.error).fieldErrors });
  return undefined;
}

function origin(value: string): string {
  const url = new URL(value);
  return url.origin;
}

function normalizeTerms(terms: string[]): string[] {
  return [...new Set(terms.map((term) => term.trim()).filter(Boolean))];
}

function ruleLabel(terms: string[]): string {
  return normalizeTerms(terms).join(" + ") || "Rule subscription";
}

function nextNumericSubscriptionId(db: SqliteDatabase): string {
  const row = db.prepare(`
    SELECT COALESCE(MAX(CASE
      WHEN id <> '' AND id NOT GLOB '*[^0-9]*' THEN CAST(id AS INTEGER)
      ELSE NULL
    END), 0) + 1 AS id
    FROM subscriptions
  `).get() as { id: number };
  return String(row.id);
}

function ownsCollection(db: SqliteDatabase, id: string, userId: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM collections WHERE id = ? AND user_id = ?").get(id, userId));
}

function ownsSubscription(db: SqliteDatabase, id: string, userId: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM subscriptions WHERE id = ? AND user_id = ?").get(id, userId));
}

function resolvedMirrors(db: SqliteDatabase, userId: string): ResolvedMirrorRow[] {
  return db.prepare(`
    SELECT tm.tracker_key, tm.display_name, tm.base_url AS global_base_url, tm.enabled,
           utm.base_url AS user_base_url, COALESCE(utm.base_url, tm.base_url) AS base_url
    FROM tracker_mirrors tm
    LEFT JOIN user_tracker_mirrors utm ON utm.tracker_key = tm.tracker_key AND utm.user_id = ?
    ORDER BY tm.display_name
  `).all(userId) as ResolvedMirrorRow[];
}

function adapterForUserUrl(db: SqliteDatabase, userId: string, value: string) {
  const canonical = adapterForUrl(value);
  if (canonical) return canonical;
  const hostname = new URL(value).hostname.toLocaleLowerCase("en-US");
  const mirror = resolvedMirrors(db, userId).find((row) => {
    const mirrorHost = new URL(row.base_url).hostname.toLocaleLowerCase("en-US");
    return hostname === mirrorHost || hostname.endsWith(`.${mirrorHost}`);
  });
  return mirror ? trackerRegistry.get(mirror.tracker_key) : undefined;
}

function serializeUser(row: UserDbRow) {
  return { id: row.id, username: row.username, isAdmin: Boolean(row.is_admin), mustChangePassword: Boolean(row.must_change_password) };
}

function serializeCollection(value: unknown) {
  const row = value as Record<string, unknown>;
  return {
    id: row.id,
    name: row.name,
    subscriptionCount: Number(row.subscription_count),
    unreadCount: Number(row.unread_count),
    updatedCount: Number(row.updated_count),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function serializeSubscription(row: SubscriptionDbRow) {
  const currentSnapshot = jsonObject(row.current_snapshot);
  const requiredTerms = jsonArray(row.required_terms);
  return {
    id: row.id,
    collectionId: row.collection_id,
    collectionName: row.collection_name,
    type: row.type,
    label: row.type === "rule"
      ? ruleLabel(requiredTerms)
      : row.name || (typeof currentSnapshot?.title === "string" ? currentSnapshot.title : "Direct subscription"),
    directUrl: row.direct_url,
    requiredTerms,
    ignoredTerms: jsonArray(row.ignored_terms),
    trackerKeys: row.tracker_keys?.split(",").filter(Boolean) || [],
    enabled: Boolean(row.enabled),
    initialized: Boolean(row.initialized),
    lastCheckedAt: row.last_checked_at,
    lastChangedAt: row.last_changed_at,
    lastError: row.last_error,
    currentSnapshot,
    isUpdated: Boolean(row.is_updated),
    isUnread: Boolean(row.manual_unread) || Number(row.unread_count) > 0,
    unreadCount: Number(row.unread_count),
    eventCount: Number(row.event_count),
    matchCount: Number(row.match_count),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function serializeEvent(row: EventRow) {
  return { id: row.id, kind: row.kind, summary: row.summary, payload: jsonObject(row.payload), createdAt: row.created_at, readAt: row.read_at };
}

function serializeMatch(row: MatchRow) {
  return { id: row.id, trackerKey: row.tracker_key, externalId: row.external_id, title: row.title, url: row.url, magnet: row.magnet, torrentUrl: row.torrent_url, discoveredAt: row.discovered_at };
}

function serializeAdminUser(row: AdminUserRow) {
  return { id: row.id, username: row.username, isAdmin: Boolean(row.is_admin), disabled: Boolean(row.disabled), mustChangePassword: Boolean(row.must_change_password), collectionCount: Number(row.collection_count), subscriptionCount: Number(row.subscription_count), createdAt: row.created_at };
}

function serializeAdminMirror(row: AdminMirrorRow) {
  return { trackerKey: row.tracker_key, displayName: row.display_name, baseUrl: row.base_url, enabled: Boolean(row.enabled), updatedAt: row.updated_at };
}

function serializeDiagnosticObservation(row: DiagnosticObservationRow) {
  return {
    id: row.id,
    runId: row.run_id,
    subscriptionId: row.subscription_id,
    subscriptionName: row.subscription_name,
    username: row.username,
    trackerKey: row.tracker_key,
    operation: row.operation,
    outcome: row.outcome,
    requestedUrl: row.requested_url,
    resolvedUrl: row.resolved_url,
    httpStatus: row.http_status,
    externalId: row.external_id,
    title: row.title,
    fingerprint: row.fingerprint,
    hasCover: nullableBoolean(row.has_cover),
    hasMagnet: nullableBoolean(row.has_magnet),
    hasTorrentFile: nullableBoolean(row.has_torrent_file),
    releaseCount: row.release_count,
    durationMs: row.duration_ms,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    details: jsonObject(row.details) || {},
    observedAt: row.observed_at,
  };
}

function serializeDiagnosticRun(row: DiagnosticRunRow) {
  return {
    id: row.id,
    trigger: row.trigger,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    checked: row.checked,
    changed: row.changed,
    errors: row.errors,
    durationMs: row.duration_ms,
  };
}

function nullableBoolean(value: number | null): boolean | null {
  return value === null ? null : Boolean(value);
}

function jsonArray(value: string): string[] {
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
}

function jsonObject(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try { return JSON.parse(value) as Record<string, unknown>; } catch { return null; }
}

function isUniqueError(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/i.test(error.message);
}

interface UserDbRow { id: string; username: string; password_hash: string; is_admin: number; disabled: number; must_change_password: number }
interface SubscriptionDbRow {
  id: string; collection_id: string; collection_name: string; type: "direct" | "rule"; name: string;
  direct_url: string | null; required_terms: string; ignored_terms: string; tracker_keys: string | null;
  enabled: number; initialized: number; last_checked_at: string | null; last_changed_at: string | null;
  last_error: string | null; current_snapshot: string | null; is_updated: number; manual_unread: number;
  unread_count: number; event_count: number; match_count: number; created_at: string; updated_at: string;
}
interface EventRow { id: string; kind: string; summary: string; payload: string; created_at: string; read_at: string | null }
interface MatchRow { id: string; tracker_key: string; external_id: string; title: string; url: string; magnet: string | null; torrent_url: string | null; discovered_at: string }
interface AdminUserRow { id: string; username: string; is_admin: number; disabled: number; must_change_password: number; created_at: string; collection_count: number; subscription_count: number }
interface AdminMirrorRow { tracker_key: string; display_name: string; base_url: string; enabled: number; updated_at: string }
interface ResolvedMirrorRow { tracker_key: TrackerKey; display_name: string; global_base_url: string; user_base_url: string | null; base_url: string; enabled: number }
interface DiagnosticObservationRow {
  id: string; run_id: string; subscription_id: string | null; subscription_name: string | null; username: string;
  tracker_key: TrackerKey; operation: string; outcome: string; requested_url: string | null; resolved_url: string | null;
  http_status: number | null; external_id: string | null; title: string | null; fingerprint: string | null;
  has_cover: number | null; has_magnet: number | null; has_torrent_file: number | null; release_count: number | null;
  duration_ms: number; error_code: string | null; error_message: string | null; details: string; observed_at: string;
}
interface DiagnosticRunRow {
  id: string; trigger: string; started_at: string; finished_at: string | null; checked: number; changed: number;
  errors: number; duration_ms: number | null;
}
