import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashSync } from "bcryptjs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApplication } from "./app.js";
import { recordTelegramDelivery, recordTrackerObservation, startSchedulerRun } from "./diagnostics.js";

let services: Awaited<ReturnType<typeof createApplication>>, path: string, adminCookie: string, memberCookie: string, adminId: string;
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const TRACKERS = ["kinozal", "rutor", "rutracker"] as const, OUTCOMES = ["unchanged", "changed", "error"] as const;
async function login(username: string, password: string): Promise<string> {
  const response = await services.app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password } });
  const header = response.headers["set-cookie"]!; return (Array.isArray(header) ? header[0] : header).split(";")[0];
}
beforeEach(async () => {
  path = mkdtempSync(join(tmpdir(), "torrentinel-admin-diagnostics-"));
  services = await createApplication({ initialAdminPassword: "admin", databasePath: join(path, "db"), encryptionKeyPath: join(path, "key"), logger: false, staticAssets: false });
  const { db } = services;
  db.prepare("UPDATE users SET must_change_password = 0, page_size = 10").run();
  adminId = (db.prepare("SELECT id FROM users").get() as { id: string }).id;
  const inboxId = (db.prepare("SELECT id FROM collections").get() as { id: string }).id;
  db.prepare("INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES ('member', 'member', ?, ?, ?)").run(hashSync("Member-Password-1", 4), minutesAgo(0), minutesAgo(0));
  adminCookie = await login("admin", "admin"); memberCookie = await login("member", "Member-Password-1");
  db.transaction(() => {
    const subscription = db.prepare(`INSERT INTO subscriptions (id, user_id, collection_id, type, name, required_terms, current_snapshot, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    subscription.run("r1", adminId, inboxId, "rule", "", '["Dune","2160p"]', null, minutesAgo(0), minutesAgo(0));
    subscription.run("d1", adminId, inboxId, "direct", "Stored name", "[]", JSON.stringify({ title: "Current release title" }), minutesAgo(0), minutesAgo(0));
    subscription.run("d2", adminId, inboxId, "direct", "Soon deleted", "[]", null, minutesAgo(0), minutesAgo(0));
    const runId = startSchedulerRun(db, "test", minutesAgo(200));
    // 30 observations, newest first by index: trackers and outcomes cycle independently.
    for (let index = 0; index < 30; index += 1) recordTrackerObservation(db, { runId, userId: adminId, subscriptionId: index % 2 ? "r1" : "d1", trackerKey: TRACKERS[index % 3], operation: "direct",
      outcome: OUTCOMES[index % 2 ? 2 : index % 4 ? 1 : 0], requestedUrl: `https://rutor.is/torrent/${index}`, durationMs: 10, observedAt: minutesAgo(index + 1) });
    // Outside the 168-hour retention window: never counted or listed.
    recordTrackerObservation(db, { runId, userId: adminId, trackerKey: "rutor", operation: "direct", outcome: "expired-outcome", durationMs: 1, observedAt: minutesAgo(169 * 60) });
    for (let index = 0; index < 12; index += 1) recordTelegramDelivery(db, { userId: adminId, subscriptionId: ["r1", "d1", "d2"][index % 3], trackerKey: "rutor", externalId: String(index), title: `Release ${index}`,
      deliveryMethod: "text", outcome: index % 5 ? "delivered" : "failed", durationMs: 20, createdAt: minutesAgo(index + 1) });
    const queue = db.prepare(`INSERT INTO notification_queue (id, dedupe_key, user_id, subscription_id, payload, attempts, next_attempt_at, created_at) VALUES (?, ?, ?, ?, '{}', ?, ?, ?)`);
    queue.run("q1", "q1", adminId, "r1", 2, minutesAgo(-5), minutesAgo(10));
    queue.run("q2", "q2", adminId, "d1", 0, minutesAgo(-10), minutesAgo(10));
    queue.run("q3", "q3", adminId, "d2", 1, minutesAgo(-15), minutesAgo(10));
  })();
});
afterEach(async () => { await services.app.close(); rmSync(path, { recursive: true, force: true }); });
const get = (url: string, cookie = adminCookie) => services.app.inject({ url, headers: cookie ? { cookie } : {} });

describe("paged administration diagnostics", () => {
  it("pages tracker logs with the user's page size, newest first, without gaps or repeats", async () => {
    const first = (await get("/api/admin/diagnostics/observations")).json();
    expect(first).toMatchObject({ retentionHours: 168, total: 30, page: 1, pageSize: 10, pageCount: 3 });
    const ids: string[] = [], times: string[] = [];
    for (let page = 1; page <= 4; page += 1) {
      const result = (await get(`/api/admin/diagnostics/observations?page=${page}&pageSize=8`)).json();
      expect(result).toMatchObject({ total: 30, pageSize: 8, pageCount: 4, page });
      expect(result.observations).toHaveLength(page === 4 ? 6 : 8);
      for (const row of result.observations) { ids.push(row.id); times.push(row.observedAt); }
    }
    expect(new Set(ids).size).toBe(30);
    expect(times).toEqual([...times].sort().reverse());
    expect(first.observations[0]).toMatchObject({ trackerKey: "kinozal", outcome: "unchanged", username: "admin", subscriptionId: "d1", subscriptionName: "Current release title", details: {} });
    expect(first.observations[1]).toMatchObject({ subscriptionId: "r1", subscriptionName: "Dune + 2160p" });
    // Past the end, the last page is returned.
    expect((await get("/api/admin/diagnostics/observations?page=99&pageSize=8")).json()).toMatchObject({ page: 4, pageCount: 4 });
  });

  it("combines tracker and outcome filters with paging and lists outcomes of the retention window", async () => {
    const all = (await get("/api/admin/diagnostics/observations")).json();
    expect(all.outcomes).toEqual(["changed", "error", "unchanged"]);
    const filtered = (await get("/api/admin/diagnostics/observations?trackerKey=rutor&outcome=error&pageSize=2")).json();
    expect(filtered).toMatchObject({ total: 5, pageCount: 3, page: 1 });
    const second = (await get("/api/admin/diagnostics/observations?trackerKey=rutor&outcome=error&pageSize=2&page=3")).json();
    expect(second.observations).toHaveLength(1);
    expect([...filtered.observations, ...second.observations].every((row: { trackerKey: string; outcome: string }) => row.trackerKey === "rutor" && row.outcome === "error")).toBe(true);
    const kinozal = (await get("/api/admin/diagnostics/observations?trackerKey=kinozal")).json();
    expect(kinozal).toMatchObject({ total: 10, outcomes: ["changed", "error", "unchanged"] });
    expect((await get("/api/admin/diagnostics/observations?outcome=unknown")).json()).toMatchObject({ total: 0, page: 1, pageCount: 1, observations: [] });
    expect(JSON.stringify(all)).not.toContain("expired-outcome");
  });

  it("pages Telegram deliveries and names subscriptions, falling back when a subscription was deleted", async () => {
    services.db.prepare("DELETE FROM subscriptions WHERE id = 'd2'").run();
    const first = (await get("/api/admin/diagnostics/deliveries?pageSize=5")).json();
    expect(first).toMatchObject({ retentionHours: 168, total: 12, page: 1, pageSize: 5, pageCount: 3 });
    expect(first.telegramDeliveries.map((row: { title: string }) => row.title)).toEqual(["Release 0", "Release 1", "Release 2", "Release 3", "Release 4"]);
    expect(first.telegramDeliveries.slice(0, 3).map((row: { subscriptionId: string | null; subscriptionName: string | null }) => [row.subscriptionId, row.subscriptionName]))
      .toEqual([["r1", "Dune + 2160p"], ["d1", "Current release title"], [null, null]]);
    const last = (await get("/api/admin/diagnostics/deliveries?pageSize=5&page=3")).json();
    expect(last.telegramDeliveries.map((row: { title: string }) => row.title)).toEqual(["Release 10", "Release 11"]);
    expect((await get("/api/admin/diagnostics/deliveries")).json()).toMatchObject({ pageSize: 10, pageCount: 2 });
  });

  it("shows subscription names in the notification queue and the id when the subscription no longer exists", async () => {
    const { db } = services;
    const queue = async () => (await get("/api/admin/diagnostics/queue")).json().notificationQueue as Array<Record<string, unknown>>;
    expect((await queue()).map((row) => [row.id, row.username, row.subscriptionId, row.subscriptionName, row.status])).toEqual([
      ["q1", "admin", "r1", "Dune + 2160p", "pending"], ["q2", "admin", "d1", "Current release title", "pending"], ["q3", "admin", "d2", "Soon deleted", "pending"]]);
    // Deleting a subscription normally removes its queue rows (ON DELETE CASCADE); rows left by older data keep the id.
    db.pragma("foreign_keys = OFF"); db.prepare("DELETE FROM subscriptions WHERE id = 'd2'").run(); db.pragma("foreign_keys = ON");
    expect((await queue()).find((row) => row.id === "q3")).toMatchObject({ subscriptionId: "d2", subscriptionName: null });
    db.prepare("DELETE FROM subscriptions WHERE id = 'd1'").run();
    expect((await queue()).map((row) => row.id)).toEqual(["q1", "q3"]);
    // The combined endpoint returns the same queue rows.
    expect((await get("/api/admin/diagnostics")).json().notificationQueue.map((row: { subscriptionName: string | null }) => row.subscriptionName)).toEqual(["Dune + 2160p", null]);
  });

  it("validates paging and filter parameters", async () => {
    for (const query of ["page=0", "page=1.5", "page=abc", "pageSize=0", "pageSize=201", "trackerKey=bogus", "outcome=", "operation=bogus"]) {
      expect((await get(`/api/admin/diagnostics/observations?${query}`)).statusCode, query).toBe(400);
    }
    for (const query of ["page=0", "pageSize=201"]) expect((await get(`/api/admin/diagnostics/deliveries?${query}`)).statusCode, query).toBe(400);
  });

  it("is available to administrators only", async () => {
    for (const url of ["/api/admin/diagnostics/observations", "/api/admin/diagnostics/deliveries", "/api/admin/diagnostics/queue"]) {
      expect((await get(url, "")).statusCode, url).toBe(401);
      expect((await get(url, memberCookie)).statusCode, url).toBe(403);
      expect((await get(url)).statusCode, url).toBe(200);
    }
    services.db.prepare("UPDATE users SET must_change_password = 1 WHERE id = ?").run(adminId);
    expect((await get("/api/admin/diagnostics/observations")).statusCode).toBe(428);
  });
});
