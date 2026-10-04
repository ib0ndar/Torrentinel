import { compare, hash } from "bcryptjs";
import { z } from "zod";
import { nowIso } from "../db.js";
import { createSession, destroyOtherSessions, destroySession, requireUser } from "../auth.js";
import { parse, type RouteServices } from "./shared.js";
import type { AuthUser } from "../types.js";
import { passwordChangeReason, themePreference } from "../types.js";

interface UserDbRow {
  id: string; username: string; password_hash: string; is_admin: number; disabled: number;
  must_change_password: number; tracker_marker_style: AuthUser["trackerMarkerStyle"];
  language: AuthUser["language"]; pagination_enabled: number; page_size: number; theme: string;
}
export function serializeUser(row: UserDbRow): AuthUser {
  return { id: row.id, username: row.username, isAdmin: Boolean(row.is_admin), mustChangePassword: Boolean(row.must_change_password),
    passwordChangeReason: passwordChangeReason(row.must_change_password),
    trackerMarkerStyle: row.tracker_marker_style, language: row.language, paginationEnabled: Boolean(row.pagination_enabled), pageSize: row.page_size,
    theme: themePreference(row.theme) };
}
export function registerAuthRoutes({ app, db }: RouteServices): void {
  app.post("/api/auth/login", async (request, reply) => {
    const input = parse(z.object({ username: z.string().trim().min(1).max(80), password: z.string().min(1).max(500) }), request.body, reply);
    if (!input) return;
    const row = db.prepare("SELECT * FROM users WHERE username = ?").get(input.username) as UserDbRow | undefined;
    if (!row || row.disabled || !(await compare(input.password, row.password_hash))) return reply.code(401).send({ error: "Invalid username or password" });
    createSession(db, reply, row.id);
    return { user: serializeUser(row) };
  });
  app.post("/api/auth/logout", { preHandler: requireUser }, async (request, reply) => {
    destroySession(db, request, reply); return { ok: true };
  });
  app.get("/api/auth/me", { preHandler: requireUser }, async (request) => ({ user: request.user }));
  app.post("/api/auth/change-password", { preHandler: requireUser }, async (request, reply) => {
    const input = parse(z.object({ currentPassword: z.string().min(1).max(500), newPassword: z.string().min(8).max(500) }), request.body, reply);
    if (!input || !request.user) return;
    const row = db.prepare("SELECT password_hash FROM users WHERE id = ?").get(request.user.id) as { password_hash: string } | undefined;
    if (!row || !(await compare(input.currentPassword, row.password_hash))) return reply.code(400).send({ error: "Current password is incorrect" });
    const passwordHash = await hash(input.newPassword, 12), userId = request.user.id;
    // Other browsers and devices must sign in again with the new password; this session stays.
    db.transaction(() => {
      db.prepare("UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?").run(passwordHash, nowIso(), userId);
      destroyOtherSessions(db, request, userId);
    })();
    request.user.mustChangePassword = false;
    delete request.user.passwordChangeReason;
    return { user: request.user };
  });
}
