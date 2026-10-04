import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApplication } from "./app.js";
import { nowIso } from "./db.js";

let services: Awaited<ReturnType<typeof createApplication>>, path: string, cookie: string, inboxId: string;
beforeEach(async () => {
  path = mkdtempSync(join(tmpdir(), "torrentinel-collections-"));
  services = await createApplication({ initialAdminPassword: "admin", databasePath: join(path, "db"), encryptionKeyPath: join(path, "key"), logger: false, staticAssets: false });
  services.db.prepare("UPDATE users SET must_change_password = 0").run();
  inboxId = (services.db.prepare("SELECT id FROM collections").get() as { id: string }).id;
  const login = await services.app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "admin" } });
  const header = login.headers["set-cookie"]!; cookie = (Array.isArray(header) ? header[0] : header).split(";")[0];
});
afterEach(async () => { await services.app.close(); rmSync(path, { recursive: true, force: true }); });

const list = async () => ((await services.app.inject({ url: "/api/collections", headers: { cookie } })).json().collections as Array<{ id: string; name: string; defaultFilter: string }>)
  .map(({ name, defaultFilter }) => [name, defaultFilter]);
const create = (payload: unknown) => services.app.inject({ method: "POST", url: "/api/collections", headers: { cookie }, payload: payload as Record<string, unknown> });
const update = (id: string, payload: unknown) => services.app.inject({ method: "PATCH", url: `/api/collections/${id}`, headers: { cookie }, payload: payload as Record<string, unknown> });

describe("default status filter per collection", () => {
  it("starts every collection on All and accepts a default when creating one", async () => {
    expect(await list()).toEqual([["Inbox", "all"]]);
    const films = await create({ name: "Films" });
    expect(films.statusCode).toBe(201); expect(films.json().collection).toMatchObject({ name: "Films", defaultFilter: "all" });
    const series = await create({ name: "Series", defaultFilter: "unread" });
    expect(series.statusCode).toBe(201); expect(series.json().collection).toMatchObject({ name: "Series", defaultFilter: "unread" });
    expect(await list()).toEqual([["Inbox", "all"], ["Films", "all"], ["Series", "unread"]]);
    for (const defaultFilter of ["paused", "", "UNREAD", null, 1]) expect((await create({ name: `Bad ${String(defaultFilter)}`, defaultFilter })).statusCode).toBe(400);
    expect(await list()).toHaveLength(3);
  });

  it("changes the name, the default filter or both, and rejects empty or invalid changes", async () => {
    const response = await update(inboxId, { defaultFilter: "errors" });
    expect(response.statusCode).toBe(200);
    expect(await list()).toEqual([["Inbox", "errors"]]);
    expect((await update(inboxId, { name: "Watchlist" })).statusCode).toBe(200);
    expect(await list()).toEqual([["Watchlist", "errors"]]);
    expect((await update(inboxId, { name: "Inbox", defaultFilter: "unread" })).statusCode).toBe(200);
    expect(await list()).toEqual([["Inbox", "unread"]]);
    for (const payload of [{}, { defaultFilter: "paused" }, { defaultFilter: null }, { name: "" }, { name: "Valid", defaultFilter: "bogus" }]) expect((await update(inboxId, payload)).statusCode).toBe(400);
    expect(await list()).toEqual([["Inbox", "unread"]]);
    await create({ name: "Films" });
    expect((await update(inboxId, { name: "Films", defaultFilter: "all" })).statusCode).toBe(409);
    expect(await list()).toEqual([["Inbox", "unread"], ["Films", "all"]]);
  });

  it("never changes another account's collection and reads unknown stored values as All", async () => {
    const { db } = services;
    db.prepare("INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES ('other', 'other', 'hash', ?, ?)").run(nowIso(), nowIso());
    db.prepare("INSERT INTO collections (id, user_id, name, created_at, updated_at) VALUES ('private', 'other', 'Private', ?, ?)").run(nowIso(), nowIso());
    expect((await update("private", { defaultFilter: "errors" })).statusCode).toBe(404);
    expect(db.prepare("SELECT default_filter FROM collections WHERE id = 'private'").get()).toEqual({ default_filter: "all" });
    db.prepare("UPDATE collections SET default_filter = 'retired-filter' WHERE id = ?").run(inboxId);
    expect(await list()).toEqual([["Inbox", "all"]]);
  });
});
