import { hashSync } from "bcryptjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApplication } from "./app.js";
import { nowIso } from "./db.js";
import { enqueueNotification } from "./notification-queue.js";
import { trackerRegistry } from "./trackers/index.js";

let directory: string, application: Awaited<ReturnType<typeof createApplication>>, cookie: string, otherCookie: string, userId: string, inboxId: string;
const password = "Example-user-password";
const preferences = { releases: "immediate", torrent: "immediate", appearance: "digest", metadata: "off" };

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "torrentinel-workflows-"));
  application = await createApplication({ databasePath: ":memory:", encryptionKeyPath: join(directory, "master.key"),
    coverCacheDir: join(directory, "covers"), initialAdminPassword: password, logger: false, staticAssets: false });
  const { app, db, scheduler } = application;
  vi.spyOn(scheduler, "queueSubscriptionCheck").mockImplementation(() => undefined);
  db.prepare("UPDATE users SET must_change_password = 0").run();
  db.prepare(`INSERT INTO users (id, username, password_hash, created_at, updated_at)
    VALUES ('other', 'other', ?, ?, ?)`).run(hashSync(password, 4), nowIso(), nowIso());
  const login = async (username: string) => {
    const response = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password } });
    expect(response.statusCode).toBe(200);
    return response.cookies.map(({ name, value }) => `${name}=${value}`).join("; ");
  };
  cookie = await login("admin");
  otherCookie = await login("other");
  userId = (db.prepare("SELECT id FROM users WHERE username = 'admin'").get() as { id: string }).id;
  inboxId = (db.prepare("SELECT id FROM collections WHERE user_id = ?").get(userId) as { id: string }).id;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await application?.app.close();
  rmSync(directory, { recursive: true, force: true });
});

const request = (method: "GET" | "POST" | "PUT" | "PATCH", url: string, payload?: object, account = cookie) =>
  application.app.inject({ method, url, headers: { cookie: account }, payload });

it("previews live tracker samples with exclusions, coverage and no subscription changes", async () => {
  const titles = ["Series 1080p WEB-DL", "Series 1080p Trailer", "Series 720p"];
  const discover = vi.spyOn(trackerRegistry.get("rutor")!.rules!, "discover").mockResolvedValue({
    coverage: { source: "recent-list", complete: false },
    releases: titles.map((title, index) => ({ trackerKey: "rutor", externalId: String(index + 1), title,
      url: `https://rutor.info/torrent/${index + 1}`, publishedAt: `2026-11-${10 + index}T00:00:00.000Z` })),
  });
  const response = await request("POST", "/api/rules/preview", { trackerKeys: ["rutor", "kinozal"], requiredTerms: ["Series", "1080P"], ignoredTerms: ["TRAILER"] });
  expect(response.statusCode).toBe(200);
  expect(response.json().trackers).toMatchObject([
    { trackerKey: "rutor", status: "ok", oldestAt: "2026-11-10T00:00:00.000Z", newestAt: "2026-11-12T00:00:00.000Z", inspected: 3, matched: 1,
      matches: [{ title: titles[0] }], excluded: [{ title: titles[1], blockedBy: ["TRAILER"], missing: [] }, { title: titles[2], blockedBy: [], missing: ["1080P"] }] },
    { trackerKey: "kinozal", status: "credentials" },
  ]);
  expect(discover).toHaveBeenCalledWith(expect.objectContaining({ userId }), { requiredTerms: ["Series", "1080P"] });
  expect((await request("GET", "/api/subscriptions")).json().total).toBe(0);
  expect((await request("GET", "/api/activity")).json().total).toBe(0);
});

it("creates the direct watch once, recognizes a different mirror and protects the rule owner's matches", async () => {
  const rule = (await request("POST", "/api/subscriptions", { type: "rule", collectionId: inboxId, trackerKeys: ["rutracker"], requiredTerms: ["Series"] })).json().subscription;
  const { db, scheduler } = application;
  db.prepare(`INSERT INTO rule_matches (id, subscription_id, tracker_key, external_id, title, url, discovered_at)
    VALUES ('match', ?, 'rutracker', '42', 'Series', 'https://rutracker.net/forum/viewtopic.php?t=42&start=20', ?)`).run(rule.id, nowIso());
  const target = `/api/subscriptions/${rule.id}/matches/match/watch`;
  expect((await request("POST", target, undefined, otherCookie)).statusCode).toBe(404);
  const [first, second] = await Promise.all([request("POST", target), request("POST", target)]);
  expect([first.statusCode, second.statusCode].sort()).toEqual([200, 201]);
  const id = first.json().id;
  expect(second.json().id).toBe(id);
  expect(scheduler.queueSubscriptionCheck).toHaveBeenCalledTimes(2);
  expect((await request("GET", `/api/subscriptions/${rule.id}`)).json().matches[0].watchedSubscriptionId).toBe(id);
  expect((await request("GET", `/api/subscriptions/${id}`)).json().subscription).toMatchObject({
    collectionId: inboxId, type: "direct", directUrl: "https://rutracker.org/forum/viewtopic.php?t=42", initialized: false,
  });
});

it("previews duplicate imports, applies them idempotently and exports portable URLs for each account", async () => {
  const url = "https://user:password@rutor.is/torrent/42/series?passkey=private#fragment";
  await request("POST", "/api/subscriptions", { type: "direct", collectionId: inboxId, url });
  const file = { format: "torrentinel-watchlist", version: 1, collections: [
    { name: "Inbox", defaultFilter: "errors", subscriptions: [{ type: "direct", url: "https://rutor.info/torrent/42/alternate" }] },
    { name: "Series", defaultFilter: "unread", subscriptions: [
      { type: "rule", trackerKeys: ["rutor", "rutracker"], requiredTerms: ["Series", "1080p"], enabled: false },
      { type: "rule", trackerKeys: ["rutracker", "rutor"], requiredTerms: ["1080P", "SERIES"] },
      { type: "direct", url: "https://example.com/torrent/42" },
    ] },
  ] };
  const preview = (await request("POST", "/api/watchlist/preview", file)).json();
  expect(preview.collections.map(({ create, adding, duplicates, unsupported }: { create: boolean; adding: number; duplicates: string[]; unsupported: string[] }) =>
    [create, adding, duplicates.length, unsupported.length])).toEqual([[false, 0, 1, 0], [true, 1, 1, 1]]);
  expect((await request("GET", "/api/collections")).json().collections).toHaveLength(1);
  expect((await request("POST", "/api/watchlist/import", file)).json()).toEqual(preview);
  expect((await request("POST", "/api/watchlist/import", file)).json().collections.every((entry: { adding: number }) => entry.adding === 0)).toBe(true);
  const exported = (await request("GET", "/api/watchlist")).json();
  expect(exported.watchlist.collections[0]).toMatchObject({ name: "Inbox", defaultFilter: "all", subscriptions: [{ url: "https://rutor.info/torrent/42" }] });
  expect(exported.watchlist.collections[1]).toMatchObject({ name: "Series", defaultFilter: "unread", subscriptions: [{ type: "rule", enabled: false }] });
  expect(JSON.stringify(exported)).not.toMatch(/private|password|passkey|fragment/);
  expect((await request("GET", "/api/watchlist", undefined, otherCookie)).json().watchlist.collections).toEqual([]);
  expect((await request("POST", "/api/watchlist/import", exported.watchlist, otherCookie)).json().collections.every((entry: { adding: number }) => entry.adding === 1)).toBe(true);
});

it("isolates Telegram settings and clears pending delivery when a subscription is muted", async () => {
  const { db } = application;
  const direct = (await request("POST", "/api/subscriptions", { type: "direct", collectionId: inboxId, url: "https://rutor.info/torrent/42" })).json().subscription;
  expect((await request("PUT", "/api/telegram/preferences", preferences)).json().preferences).toEqual(preferences);
  expect((await request("GET", "/api/telegram/preferences", undefined, otherCookie)).json().preferences.appearance).toBe("immediate");
  enqueueNotification(db, userId, "queued", { subscriptionId: direct.id, trackerName: "Rutor", changes: ["cover changed"],
    release: { trackerKey: "rutor", externalId: "42", title: "Series", url: "https://rutor.info/torrent/42" } });
  expect(db.prepare("SELECT digest_at FROM notification_queue").get()).toEqual({ digest_at: expect.stringMatching(/T09:00:00\.000Z$/) });
  expect((await request("PATCH", `/api/subscriptions/${direct.id}`, { telegramMuted: true })).statusCode).toBe(200);
  expect(db.prepare("SELECT digest_at FROM notification_queue").get()).toBeUndefined();
  expect((await request("GET", `/api/subscriptions/${direct.id}`)).json().subscription).toMatchObject({ telegramMuted: true, enabled: true });
});
