import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createHash, randomBytes } from "node:crypto";
import type { SqliteDatabase } from "./db.js";
import { nowIso } from "./db.js";
import { config } from "./config.js";
import type { AuthUser } from "./types.js";

declare module "fastify" {
  interface FastifyRequest {
    user: AuthUser | null;
  }
}

const COOKIE_NAME = "torrentinel_session";

interface UserRow {
  id: string;
  username: string;
  is_admin: number;
  disabled: number;
  must_change_password: number;
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
  };
}

export function registerAuth(app: FastifyInstance, db: SqliteDatabase): void {
  app.decorateRequest("user", null);

  app.addHook("preHandler", async (request) => {
    const token = request.cookies[COOKIE_NAME];
    if (!token) return;

    const row = db.prepare(`
      SELECT u.id, u.username, u.is_admin, u.disabled, u.must_change_password
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ?
    `).get(tokenHash(token), nowIso()) as UserRow | undefined;

    if (row && !row.disabled) request.user = toAuthUser(row);
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

export async function requireUser(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!request.user) {
    await reply.code(401).send({ error: "Authentication required" });
  }
}

export async function requireReadyUser(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!request.user) {
    await reply.code(401).send({ error: "Authentication required" });
    return;
  }
  if (request.user.mustChangePassword) {
    await reply.code(428).send({ error: "Password change required", code: "PASSWORD_CHANGE_REQUIRED" });
  }
}

export async function requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!request.user) {
    await reply.code(401).send({ error: "Authentication required" });
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
