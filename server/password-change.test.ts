import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashSync } from "bcryptjs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApplication } from "./app.js";

let services: Awaited<ReturnType<typeof createApplication>>, path: string;
beforeEach(async () => {
  path = mkdtempSync(join(tmpdir(), "torrentinel-password-"));
  services = await createApplication({ databasePath: join(path, "db"), encryptionKeyPath: join(path, "key"), logger: false, staticAssets: false });
  services.db.prepare("INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES ('member', 'member', ?, ?, ?)").run(hashSync("Member-Password-1", 4), new Date().toISOString(), new Date().toISOString());
});
afterEach(async () => { await services.app.close(); rmSync(path, { recursive: true, force: true }); });
async function login(username: string, password: string): Promise<{ status: number; cookie: string }> {
  const response = await services.app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password } });
  const header = response.headers["set-cookie"];
  return { status: response.statusCode, cookie: header ? (Array.isArray(header) ? header[0] : header).split(";")[0] : "" };
}
const me = (cookie: string) => services.app.inject({ url: "/api/auth/me", headers: { cookie } });
const changePassword = (cookie: string, currentPassword: string, newPassword: string) =>
  services.app.inject({ method: "POST", url: "/api/auth/change-password", headers: { cookie }, payload: { currentPassword, newPassword } });
const sessionCount = (userId: string) => (services.db.prepare("SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?").get(userId) as { count: number }).count;

describe("password change", () => {
  it("keeps the forced first sign-in change working and signs out the account's other sessions", async () => {
    const first = (await login("admin", "admin")).cookie, second = (await login("admin", "admin")).cookie;
    expect((await me(first)).json().user.mustChangePassword).toBe(true);
    const changed = await changePassword(first, "admin", "Admin-Password-2026");
    expect(changed.statusCode).toBe(200);
    expect(changed.json().user).toMatchObject({ username: "admin", mustChangePassword: false });
    expect((await me(first)).statusCode).toBe(200);
    expect((await me(first)).json().user.mustChangePassword).toBe(false);
    expect((await me(second)).statusCode).toBe(401);
    expect((await login("admin", "admin")).status).toBe(401);
    expect((await login("admin", "Admin-Password-2026")).status).toBe(200);
  });

  it("signs out every other session of the user after a self-service change, but keeps the current one and other users' sessions", async () => {
    services.db.prepare("UPDATE users SET must_change_password = 0").run();
    const current = (await login("admin", "admin")).cookie, phone = (await login("admin", "admin")).cookie, tablet = (await login("admin", "admin")).cookie;
    const member = (await login("member", "Member-Password-1")).cookie;
    const adminId = (await me(current)).json().user.id as string;
    expect(sessionCount(adminId)).toBe(3);

    // A wrong current password or a too-short new password changes nothing.
    const wrong = await changePassword(current, "not-the-password", "Admin-Password-2026");
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error).toBe("Current password is incorrect");
    expect((await changePassword(current, "admin", "short")).statusCode).toBe(400);
    expect(sessionCount(adminId)).toBe(3);

    const changed = await changePassword(current, "admin", "Admin-Password-2026");
    expect(changed.statusCode).toBe(200);
    expect(JSON.stringify(changed.json())).not.toContain("Admin-Password-2026");
    expect(sessionCount(adminId)).toBe(1);
    for (const cookie of [phone, tablet]) {
      expect((await me(cookie)).statusCode).toBe(401);
      expect((await services.app.inject({ url: "/api/collections", headers: { cookie } })).statusCode).toBe(401);
    }
    expect((await services.app.inject({ url: "/api/collections", headers: { cookie: current } })).statusCode).toBe(200);
    expect((await me(member)).statusCode).toBe(200);
    expect((await login("admin", "admin")).status).toBe(401);
    const again = await login("admin", "Admin-Password-2026");
    expect(again.status).toBe(200);
    expect((await me(again.cookie)).statusCode).toBe(200);
    expect((await me(current)).statusCode).toBe(200);
  });
});
