import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createHash, randomBytes } from "node:crypto";
import type { SqliteDatabase } from "./db.js";
import { nowIso } from "./db.js";
import { config } from "./config.js";
import type { AuthUser, TrackerMarkerStyle } from "./types.js";
import { passwordChangeReason, startPagePreference, themePreference } from "./types.js";

declare module "fastify" {
  interface FastifyRequest {
    user: AuthUser | null;
    /** Set when the request's session cookie belongs to a session someone else ended. */
    sessionEndReason: SessionEndReason | null;
  }
}

export type SessionEndReason = "password-reset" | "password-changed" | "account-disabled";
const SESSION_END_REASONS: readonly string[] = ["password-reset", "password-changed", "account-disabled"];

const COOKIE_NAME = "torrentinel_session";

interface UserRow {
  id: string;
  username: string;
  is_admin: number;
  disabled: number;
  must_change_password: number;
  tracker_marker_style: TrackerMarkerStyle;
  language: AuthUser["language"];
  pagination_enabled: number;
  page_size: number;
  theme: string;
  start_page: string;
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function toAuthUser(row: UserRow): AuthUser {
  return {
    id: row.id,
    username: row.username,
    isAdmin: Boolean(row.is_admin),
    mustChangePassword: Boolean(row.must_change_password),
    passwordChangeReason: passwordChangeReason(row.must_change_password),
    trackerMarkerStyle: row.tracker_marker_style,
    language: row.language,
    paginationEnabled: Boolean(row.pagination_enabled),
    pageSize: row.page_size,
    theme: themePreference(row.theme),
    startPage: startPagePreference(row.start_page),
  };
}

export function registerAuth(app: FastifyInstance, db: SqliteDatabase): void {
  app.decorateRequest("user", null);
  app.decorateRequest("sessionEndReason", null);

  app.addHook("preHandler", async (request) => {
    const token = request.cookies[COOKIE_NAME];
    if (!token) return;

    const row = db.prepare(`
      SELECT u.id, u.username, u.is_admin, u.disabled, u.must_change_password, u.tracker_marker_style, u.language, u.pagination_enabled, u.page_size, u.theme, u.start_page
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ?
    `).get(tokenHash(token), nowIso()) as UserRow | undefined;

    if (row && !row.disabled) { request.user = toAuthUser(row); return; }
    if (row) return;
    const ended = db.prepare("SELECT reason FROM revoked_sessions WHERE token_hash = ? AND expires_at > ?").get(tokenHash(token), nowIso()) as { reason: string } | undefined;
    if (ended && SESSION_END_REASONS.includes(ended.reason)) request.sessionEndReason = ended.reason as SessionEndReason;
  });
}

export function createSession(db: SqliteDatabase, reply: FastifyReply, userId: string): void {
  const token = randomBytes(32).toString("base64url");
  const expires = new Date(Date.now() + config.sessionDays * 86_400_000);
  db.prepare(`
    INSERT INTO sessions (token_hash, user_id, expires_at, created_at)
    VALUES (?, ?, ?, ?)
  `).run(tokenHash(token), userId, expires.toISOString(), nowIso());

  reply.setCookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "strict",
    secure: config.sessionCookieSecure,
    path: "/",
    expires,
  });
}

export function destroySession(db: SqliteDatabase, request: FastifyRequest, reply: FastifyReply): void {
  const token = request.cookies[COOKIE_NAME];
  if (token) db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash(token));
  reply.clearCookie(COOKIE_NAME, { path: "/" });
}

// Ends the user's sessions (except one, if given) and records why, so a later request with an ended
// session's cookie is told what happened. The sessions themselves are deleted as before.
export function revokeSessions(db: SqliteDatabase, userId: string, reason: SessionEndReason, keepTokenHash = ""): number {
  db.prepare(`INSERT OR REPLACE INTO revoked_sessions (token_hash, reason, expires_at)
    SELECT token_hash, ?, expires_at FROM sessions WHERE user_id = ? AND token_hash <> ?`).run(reason, userId, keepTokenHash);
  return db.prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?").run(userId, keepTokenHash).changes;
}

// Ends every session of the user except the one making this request.
export function destroyOtherSessions(db: SqliteDatabase, request: FastifyRequest, userId: string): number {
  const token = request.cookies[COOKIE_NAME];
  return revokeSessions(db, userId, "password-changed", token ? tokenHash(token) : "");
}

async function authenticationRequired(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  await reply.code(401).send(request.sessionEndReason
    ? { error: "Authentication required", code: "SESSION_ENDED", details: { reason: request.sessionEndReason } }
    : { error: "Authentication required" });
}

export async function requireUser(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!request.user) await authenticationRequired(request, reply);
}

export async function requireReadyUser(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!request.user) {
    await authenticationRequired(request, reply);
    return;
  }
  if (request.user.mustChangePassword) {
    await reply.code(428).send({ error: "Password change required", code: "PASSWORD_CHANGE_REQUIRED" });
  }
}

export async function requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!request.user) {
    await authenticationRequired(request, reply);
    return;
  }
  if (request.user.mustChangePassword) {
    await reply.code(428).send({ error: "Password change required", code: "PASSWORD_CHANGE_REQUIRED" });
    return;
  }
  if (!request.user.isAdmin) {
    await reply.code(403).send({ error: "Administrator access required" });
  }
}
