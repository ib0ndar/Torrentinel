import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApplication } from "./app.js";

let services: Awaited<ReturnType<typeof createApplication>>, path: string, cookie: string, userId: string, inboxId: string;
const at = (minute: number) => new Date(Date.UTC(2026, 8, 1, 12, minute)).toISOString();
beforeEach(async () => {
  path = mkdtempSync(join(tmpdir(), "torrentinel-activity-"));
  services = await createApplication({ initialAdminPassword: "admin", databasePath: join(path, "db"), encryptionKeyPath: join(path, "key"), logger: false, staticAssets: false });
  const { app, db } = services;
  db.prepare("UPDATE users SET must_change_password = 0").run();
  userId = (db.prepare("SELECT id FROM users").get() as { id: string }).id;
  inboxId = (db.prepare("SELECT id FROM collections").get() as { id: string }).id;
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "admin" } });
  const header = login.headers["set-cookie"]!; cookie = (Array.isArray(header) ? header[0] : header).split(";")[0];
  db.transaction(() => {
    db.prepare("INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES ('other', 'other', 'hash', ?, ?)").run(at(0), at(0));
    const collection = db.prepare("INSERT INTO collections (id, user_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)");
    collection.run("films", userId, "Films", at(0), at(0)); collection.run("private", "other", "Private", at(0), at(0));
    const subscription = db.prepare(`INSERT INTO subscriptions (id, user_id, collection_id, type, name, required_terms, ignored_terms, current_snapshot, manual_unread, initialized, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`);
    subscription.run("d1", userId, inboxId, "direct", "Stored name", "[]", "[]", JSON.stringify({ title: "Current title", metadata: { large: "x".repeat(5_000) } }), 0, at(0), at(0));
    subscription.run("r1", userId, "films", "rule", "", '["Dune","2160p"]', '["Trailer"]', null, 0, at(0), at(0));
    subscription.run("d2", userId, "films", "direct", "Reminder", "[]", "[]", null, 1, at(0), at(0));
    subscription.run("p1", "other", "private", "direct", "Secret", "[]", "[]", null, 1, at(0), at(0));
    const tracker = db.prepare("INSERT INTO subscription_trackers (subscription_id, tracker_key) VALUES (?, ?)");
    tracker.run("d1", "rutor"); tracker.run("r1", "rutracker"); tracker.run("r1", "kinozal"); tracker.run("d2", "kinozal"); tracker.run("p1", "rutor");
    const event = db.prepare("INSERT INTO subscription_events (id, subscription_id, user_id, kind, summary, payload, created_at, read_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    const snapshot = (title: string, magnet: string) => ({ title, url: "https://rutor.info/torrent/1", magnet, torrentUrl: "https://rutor.info/download/1", metadata: { large: "x".repeat(5_000) } });
    event.run("e1", "d1", userId, "direct-change", "title changed, magnet changed", JSON.stringify({ previous: snapshot("Old title", "magnet:?old"), current: snapshot("Current title", "magnet:?new"), changes: ["title changed", "magnet changed"] }), at(10), null);
    event.run("e2", "d1", userId, "direct-change", "metadata changed", JSON.stringify({ changes: ["metadata changed"] }), at(5), at(6));
    event.run("e3", "r1", userId, "rule-match", "New match: Dune", JSON.stringify({ releases: [{ trackerKey: "rutracker", externalId: "1", title: "Dune 2160p", url: "https://rutracker.org/forum/viewtopic.php?t=1", magnet: "magnet:?dune", metadata: { large: "x" } }] }), at(20), null);
    event.run("e4", "d2", userId, "direct-change", "cover changed", "{}", at(1), at(2));
    event.run("e5", "d2", userId, "direct-change", "torrent file changed", "{}", at(15), at(16));
    event.run("p1e", "p1", "other", "direct-change", "secret changed", "{}", at(30), null);
  })();
});
afterEach(async () => { await services.app.close(); rmSync(path, { recursive: true, force: true }); });
const get = (query = "") => services.app.inject({ url: `/api/activity${query}`, headers: { cookie } });
const markRead = (payload: Record<string, unknown> = {}) => services.app.inject({ method: "POST", url: "/api/activity/read", headers: { cookie }, payload });
const collections = async () => Object.fromEntries(((await services.app.inject({ url: "/api/collections", headers: { cookie } })).json().collections as Array<{ name: string; unreadCount: number }>).map((item) => [item.name, item.unreadCount]));
const activityCounts = async () => Object.fromEntries(((await services.app.inject({ url: "/api/collections", headers: { cookie } })).json().collections as Array<{ name: string; activityCount: number }>).map((item) => [item.name, item.activityCount]));

describe("activity across collections", () => {
  it("lists only unread changes newest first, lists manual reminders separately, and never another account's data", async () => {
    const unread = (await get()).json();
    expect(unread).toMatchObject({ total: 2, page: 1, pageCount: 1, pageSize: 50 });
    expect(unread.events.map((event: { id: string }) => event.id)).toEqual(["e3", "e1"]);
    expect(unread.events.every((event: { isUnread: boolean; readAt: string | null }) => event.isUnread && event.readAt === null)).toBe(true);
    expect(unread.events[0]).toMatchObject({ kind: "rule-match", readAt: null, subscription: { id: "r1", type: "rule", label: "Dune + 2160p", requiredTerms: ["Dune", "2160p"], ignoredTerms: ["Trailer"], trackerKeys: expect.arrayContaining(["rutracker", "kinozal"]) }, collection: { id: "films", name: "Films" } });
    expect(unread.events[0].payload.releases).toEqual([{ trackerKey: "rutracker", title: "Dune 2160p", url: "https://rutracker.org/forum/viewtopic.php?t=1", magnet: "magnet:?dune" }]);
    expect(unread.reminders).toEqual([{ subscription: { id: "d2", type: "direct", label: "Reminder", directUrl: null, requiredTerms: [], ignoredTerms: [], trackerKeys: ["kinozal"] }, collection: { id: "films", name: "Films" }, lastChangedAt: null }]);
    expect(unread.events[1]).toMatchObject({ subscription: { label: "Current title", type: "direct" }, collection: { name: "Inbox" },
      payload: { changes: ["title changed", "magnet changed"], previous: { title: "Old title", magnet: "magnet:?old" }, current: { title: "Current title", magnet: "magnet:?new" } } });
    expect(JSON.stringify(unread)).not.toContain("xxxxx");
    expect(JSON.stringify(unread)).not.toContain("Secret");

    const all = (await get("?filter=all")).json();
    expect(all.total).toBe(5);
    expect(all.reminders).toEqual([]);
    expect(all.events.map((event: { id: string }) => event.id)).toEqual(["e3", "e5", "e1", "e2", "e4"]);
    expect(all.events.map((event: { isUnread: boolean }) => event.isUnread)).toEqual([true, false, true, false, false]);
    expect(all.events[3].payload).toEqual({ changes: ["metadata changed"] });
    expect(JSON.stringify(all)).not.toContain("secret");
  });

  it("counts the same unread items for the Activity badge as the unread view lists", async () => {
    const total = async () => { const unread = (await get()).json(); return unread.total + unread.reminders.length; };
    const badge = async () => Object.values(await activityCounts()).reduce((sum: number, value) => sum + Number(value), 0);
    expect(await activityCounts()).toEqual({ Inbox: 1, Films: 2 });
    expect(await badge()).toBe(await total());
    // A reminder on a subscription that already has an unread change is not listed twice.
    services.db.prepare("UPDATE subscriptions SET manual_unread = 1 WHERE id = 'd1'").run();
    expect((await get()).json().reminders.map((reminder: { subscription: { id: string } }) => reminder.subscription.id)).toEqual(["d2"]);
    expect(await activityCounts()).toEqual({ Inbox: 1, Films: 2 });
    // Several unread changes on one subscription count once each in both places.
    services.db.prepare("UPDATE subscription_events SET read_at = NULL WHERE id = 'e2'").run();
    expect(await activityCounts()).toEqual({ Inbox: 2, Films: 2 });
    expect(await collections()).toEqual({ Inbox: 1, Films: 2 });
    expect(await badge()).toBe(await total());
  });

  it("counts failed subscriptions per collection like the Errors filter, for the signed-in account only", async () => {
    const errorCounts = async () => Object.fromEntries(((await services.app.inject({ url: "/api/collections", headers: { cookie } })).json().collections as Array<{ name: string; errorCount: number }>).map((item) => [item.name, item.errorCount]));
    expect(await errorCounts()).toEqual({ Inbox: 0, Films: 0 });
    const fail = services.db.prepare("UPDATE subscriptions SET last_error = ? WHERE id = ?");
    fail.run("HTTP 503", "r1"); fail.run("Blocked by the tracker", "d2"); fail.run("", "d1"); fail.run("Secret failure", "p1");
    expect(await errorCounts()).toEqual({ Inbox: 0, Films: 2 });
    const filtered = (await services.app.inject({ url: "/api/subscriptions?collectionId=films&filter=errors", headers: { cookie } })).json();
    expect(filtered.subscriptions.map((subscription: { id: string }) => subscription.id).sort()).toEqual(["d2", "r1"]);
    const inbox = (await services.app.inject({ url: `/api/subscriptions?collectionId=${inboxId}&filter=errors`, headers: { cookie } })).json();
    expect(inbox.subscriptions).toEqual([]);
    const created = await services.app.inject({ method: "POST", url: "/api/collections", headers: { cookie }, payload: { name: "Series" } });
    expect(created.json().collection).toMatchObject({ name: "Series", subscriptionCount: 0, unreadCount: 0, activityCount: 0, errorCount: 0 });
    fail.run(null, "r1");
    expect(await errorCounts()).toEqual({ Inbox: 0, Films: 1, Series: 0 });
  });

  it("pages deterministically, clamps the last page, and validates parameters", async () => {
    const pages = [1, 2, 3].map(async (page) => (await get(`?filter=all&page=${page}&pageSize=2`)).json());
    const [first, second, third] = await Promise.all(pages);
    expect(first).toMatchObject({ total: 5, page: 1, pageCount: 3, pageSize: 2 });
    expect([...first.events, ...second.events, ...third.events].map((event: { id: string }) => event.id)).toEqual(["e3", "e5", "e1", "e2", "e4"]);
    expect((await get("?filter=all&page=99&pageSize=2")).json()).toMatchObject({ page: 3, events: [{ id: "e4" }] });
    for (const query of ["?filter=bogus", "?page=0", "?page=1.5", "?pageSize=0", "?pageSize=201"]) expect((await get(query)).statusCode).toBe(400);
    expect((await services.app.inject({ url: "/api/activity" })).statusCode).toBe(401);
    services.db.prepare("UPDATE subscription_events SET read_at = ? WHERE user_id = ?").run(at(40), userId);
    services.db.prepare("UPDATE subscriptions SET manual_unread = 0 WHERE user_id = ?").run(userId);
    expect((await get()).json()).toMatchObject({ total: 0, page: 1, pageCount: 1, events: [], reminders: [] });
  });

  it("marks one collection, then everything, read and clears manual reminders without touching other accounts", async () => {
    expect(await collections()).toEqual({ Inbox: 1, Films: 2 });
    const films = await markRead({ collectionId: "films" });
    expect(films.statusCode).toBe(200);
    expect(films.json()).toEqual({ ok: true, subscriptions: 2, events: 1 });
    expect(await collections()).toEqual({ Inbox: 1, Films: 0 });
    expect(services.db.prepare("SELECT manual_unread FROM subscriptions WHERE id = 'd2'").get()).toEqual({ manual_unread: 0 });
    expect((await get()).json().events.map((event: { id: string }) => event.id)).toEqual(["e1"]);
    expect(services.db.prepare("SELECT read_at FROM subscription_events WHERE id = 'e2'").get()).toEqual({ read_at: at(6) });

    for (const collectionId of ["private", "missing"]) expect((await markRead({ collectionId })).statusCode).toBe(404);
    expect((await markRead({ collectionId: "" })).statusCode).toBe(400);
    expect((await services.app.inject({ method: "POST", url: "/api/activity/read", payload: {} })).statusCode).toBe(401);

    services.db.prepare("UPDATE subscriptions SET manual_unread = 1 WHERE id = 'r1'").run();
    expect((await markRead()).json()).toEqual({ ok: true, subscriptions: 2, events: 1 });
    expect(await collections()).toEqual({ Inbox: 0, Films: 0 });
    expect((await get()).json().total).toBe(0);
    expect((await markRead()).json()).toEqual({ ok: true, subscriptions: 0, events: 0 });
    expect(services.db.prepare("SELECT read_at, (SELECT manual_unread FROM subscriptions WHERE id = 'p1') AS manual FROM subscription_events WHERE id = 'p1e'").get()).toEqual({ read_at: null, manual: 1 });
  });
});
