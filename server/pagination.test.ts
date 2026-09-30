import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApplication } from "./app.js";
import { nowIso } from "./db.js";

let services: Awaited<ReturnType<typeof createApplication>>, path: string, cookie: string, userId: string, collectionId: string;
beforeEach(async () => {
  path = mkdtempSync(join(tmpdir(), "torrentinel-pagination-"));
  services = await createApplication({ databasePath: join(path, "db"), encryptionKeyPath: join(path, "key"), logger: false, staticAssets: false });
  const { app, db } = services;
  db.prepare("UPDATE users SET must_change_password = 0").run();
  userId = (db.prepare("SELECT id FROM users").get() as { id: string }).id;
  collectionId = (db.prepare("SELECT id FROM collections").get() as { id: string }).id;
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "admin" } });
  const header = login.headers["set-cookie"]!; cookie = (Array.isArray(header) ? header[0] : header).split(";")[0];
  db.transaction(() => {
    const statement = db.prepare(`INSERT INTO subscriptions (id, user_id, collection_id, type, name, required_terms, manual_unread, last_error, current_snapshot, created_at, updated_at)
      VALUES (?, ?, ?, 'direct', ?, '[]', ?, ?, ?, ?, ?)`);
    for (let i = 1; i <= 137; i += 1) {
      statement.run(String(i), userId, collectionId, `РЕЛИЗ ${i}`, i % 2, i % 3 === 0 ? "offline" : null, JSON.stringify({ title: `РЕЛИЗ ${i}`, metadata: { large: "x".repeat(10_000) } }), nowIso(), nowIso());
      db.prepare("INSERT INTO subscription_trackers (subscription_id, tracker_key) VALUES (?, 'rutor')").run(String(i));
    }
  })();
});
afterEach(async () => { await services.app.close(); rmSync(path, { recursive: true, force: true }); });
function get(query = "") { return services.app.inject({ url: `/api/subscriptions?view=summary&collectionId=${collectionId}&${query}`, headers: { cookie } }); }

describe("server-side collection paging and filtering", () => {
  it("pages deterministically without repeated or missing records and omits snapshots", async () => {
    const ids = new Set<string>();
    for (let page = 1; page <= 6; page += 1) {
      const response = await get(`page=${page}&pageSize=25`); expect(response.statusCode).toBe(200);
      const result = response.json(); expect(result).toMatchObject({ total: 137, page, pageCount: 6, pageSize: 25 });
      expect(result.subscriptions).toHaveLength(page === 6 ? 12 : 25);
      for (const item of result.subscriptions) { expect(item.currentSnapshot).toBeUndefined(); expect(ids.has(item.id)).toBe(false); ids.add(item.id); }
      expect(response.body.length).toBeLessThan(30_000);
    }
    expect(ids.size).toBe(137);
  });
  it("retains full-list behavior with pagination off", async () => {
    const result = (await get()).json(); expect(result.subscriptions).toHaveLength(137); expect(result.pageCount).toBe(1);
  });
  it("searches off-page Cyrillic titles case-insensitively", async () => {
    const result = (await get(`page=1&pageSize=25&search=${encodeURIComponent("релиз 1")}`)).json();
    expect(result.total).toBe(49); expect(result.subscriptions).toHaveLength(25);
    expect(result.subscriptions.every((item: { label: string }) => item.label.toLowerCase().includes("релиз 1"))).toBe(true);
    const exact = (await get(`page=1&search=${encodeURIComponent("релиз 137")}`)).json(); expect(exact.total).toBe(1); expect(exact.subscriptions[0].id).toBe("137");
    services.db.prepare("UPDATE subscriptions SET type = 'rule', name = '', current_snapshot = NULL, required_terms = '[\"Example\",\"Series\"]' WHERE id = '1'").run();
    for (const search of ["example series", "example + series"]) {
      const result = (await get(`page=1&search=${encodeURIComponent(search)}`)).json(); expect(result.total).toBe(1); expect(result.subscriptions[0].id).toBe("1");
    }
  });
  it("applies unread and error filters before counting and limiting", async () => {
    expect((await get("page=1&pageSize=25&filter=unread")).json()).toMatchObject({ total: 69, pageCount: 3 });
    const errors = (await get("page=2&pageSize=25&filter=errors")).json(); expect(errors).toMatchObject({ total: 45, pageCount: 2 }); expect(errors.subscriptions).toHaveLength(20);
    const combined = (await get(`page=1&filter=errors&search=${encodeURIComponent("релиз 12")}`)).json(); expect(combined.total).toBe(5);
  });
  it("clamps deleted/empty last pages and validates bounds", async () => {
    expect((await get("page=999999&pageSize=25")).json()).toMatchObject({ page: 6, pageCount: 6 });
    expect((await get("page=1&search=absent")).json()).toMatchObject({ total: 0, page: 1, pageCount: 1, subscriptions: [] });
    for (const input of ["page=0", "page=-1", "page=1.5", "page=1000001", "pageSize=201", "pageSize=0", "filter=bogus", "search=" + "a".repeat(201)]) expect((await get(input)).statusCode).toBe(400);
  });
  it("never discloses another account's collection or counts", async () => {
    const { db } = services;
    db.prepare("INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES ('other', 'other', 'hash', ?, ?)").run(nowIso(), nowIso());
    db.prepare("INSERT INTO collections (id, user_id, name, created_at, updated_at) VALUES ('private', 'other', 'Private', ?, ?)").run(nowIso(), nowIso());
    db.prepare("INSERT INTO subscriptions (id, user_id, collection_id, type, name, created_at, updated_at) VALUES ('private', 'other', 'private', 'rule', 'secret', ?, ?)").run(nowIso(), nowIso());
    const response = await services.app.inject({ url: "/api/subscriptions?collectionId=private&page=1&view=summary", headers: { cookie } }); expect(response.json()).toMatchObject({ total: 0, subscriptions: [] });
    expect((await get("page=1")).json().total).toBe(137);
  });
  it("persists per-user language, pagination and page-size preferences", async () => {
    const { app } = services;
    const initial = await app.inject({ url: "/api/auth/me", headers: { cookie } }); expect(initial.json().user).toMatchObject({ language: "en", paginationEnabled: true, pageSize: 50 });
    const updated = await app.inject({ method: "PUT", url: "/api/settings/preferences", headers: { cookie }, payload: { language: "ru", paginationEnabled: false, pageSize: 100 } }); expect(updated.json().user).toMatchObject({ language: "ru", paginationEnabled: false, pageSize: 100 });
    expect((await app.inject({ url: "/api/auth/me", headers: { cookie } })).json().user).toMatchObject({ language: "ru", paginationEnabled: false, pageSize: 100 });
    expect((await get("page=1")).json().subscriptions).toHaveLength(100);
    for (const payload of [{ language: "de" }, { pageSize: 26 }, { paginationEnabled: "false" }]) expect((await app.inject({ method: "PUT", url: "/api/settings/preferences", headers: { cookie }, payload })).statusCode).toBe(400);
    expect((await app.inject({ method: "PUT", url: "/api/settings/preferences", payload: { language: "ru" } })).statusCode).toBe(401);
  });
});
