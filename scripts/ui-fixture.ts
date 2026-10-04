// Isolated UI fixture for layout checks: a temporary database with fictional collections, subscriptions,
// diagnostics and a second account, served with the built web interface (dist/public). Tracker requests
// are stubbed, the scheduler and Telegram are not started, and nothing is written inside the repository.
//
//   npm run build && node --import tsx scripts/ui-fixture.ts [--port=9878]   (sign in as admin / admin)
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import { hashSync } from "bcryptjs";
import { createApplication } from "../server/app.js";
import { recordTelegramDelivery, recordTrackerObservation, startSchedulerRun } from "../server/diagnostics.js";
import { writeTrackerCredentials } from "../server/secrets.js";
import { trackerRegistry } from "../server/trackers/index.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const publicDir = resolve(root, "dist/public");
const portArgument = process.argv.find((argument) => argument.startsWith("--port="))?.slice("--port=".length);
const port = Number(portArgument ?? process.env.UI_FIXTURE_PORT ?? 9878);
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`Invalid port: ${portArgument ?? process.env.UI_FIXTURE_PORT}`);
if (!existsSync(resolve(publicDir, "index.html"))) throw new Error("dist/public/index.html is missing; run npm run build first");

const dataDir = mkdtempSync(join(tmpdir(), "torrentinel-ui-fixture-"));
const { app, db, vault } = await createApplication({ initialAdminPassword: "admin", databasePath: join(dataDir, "fixture.db"), encryptionKeyPath: join(dataDir, "master.key"), staticAssets: false, logger: false });
const userId = (db.prepare("SELECT id FROM users WHERE username = 'admin'").get() as { id: string }).id;
const inboxId = (db.prepare("SELECT id FROM collections WHERE user_id = ?").get(userId) as { id: string }).id;
db.prepare("UPDATE users SET must_change_password = 0, page_size = 20 WHERE id = ?").run(userId);
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const TRACKERS = ["rutracker", "kinozal", "rutor"] as const;
const trackerUrl = (tracker: (typeof TRACKERS)[number], id: number) => tracker === "rutracker" ? `https://rutracker.org/forum/viewtopic.php?t=${id}` : tracker === "kinozal" ? `https://kinozal.tv/details.php?id=${id}` : `https://rutor.info/torrent/${id}`;

// Collections "series", "films" (opens on Errors, which is empty), "docs" (opens on Unread) and "archive"
// (34 entries, two pages) plus the admin's Inbox.
db.transaction(() => {
  const collections = [["series", "Series 2026", "all"], ["films", "Films", "errors"], ["docs", "Documentaries", "unread"], ["archive", "Archive", "all"]];
  for (const [id, name, defaultFilter] of collections) db.prepare("INSERT INTO collections (id, user_id, name, default_filter, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, userId, name, defaultFilter, ago(5000), ago(5000));
  const sub = db.prepare(`INSERT INTO subscriptions (id, user_id, collection_id, type, name, direct_url, required_terms, ignored_terms, enabled, initialized, last_checked_at, last_changed_at, last_error, current_fingerprint, current_snapshot, manual_unread, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'fp', ?, ?, ?, ?)`);
  const track = db.prepare("INSERT INTO subscription_trackers (subscription_id, tracker_key) VALUES (?, ?)");
  const state = db.prepare("INSERT INTO subscription_tracker_state (subscription_id, tracker_key, initialized) VALUES (?, ?, 1)");
  const event = db.prepare("INSERT INTO subscription_events (id, subscription_id, user_id, kind, summary, payload, created_at, read_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  const match = db.prepare("INSERT INTO rule_matches (id, subscription_id, tracker_key, external_id, title, url, magnet, torrent_url, discovered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const titles = ["Severance / Разделение (Сезон 2, Серии 1-10 из 10) WEB-DL 2160p HDR", "The Last of Us / Одни из нас (Сезон 2) WEB-DLRip 1080p", "Andor / Андор (Сезон 2, Серии 1-12) WEB-DL 1080p", "Шёгун / Shōgun (Сезон 1) BDRip 1080p",
    "Dune: Part Two / Дюна: Часть вторая (2024) UHD BDRemux 2160p", "Slow Horses / Медленные лошади (Сезон 5) WEB-DL 720p", "Fallout / Фоллаут (Сезон 2, Серия 1-4 из 8) WEB-DL 1080p", "Planet Earth III / Планета Земля III (2023) BDRip 1080p"];
  let n = 0;
  for (const [index, title] of titles.entries()) {
    const id = `d${index}`, tracker = TRACKERS[index % 3], collection = index < 4 ? "series" : index < 6 ? "films" : index < 7 ? inboxId : "docs";
    const url = trackerUrl(tracker, (tracker === "rutracker" ? 6_500_000 : tracker === "kinozal" ? 2_000_000 : 900_000) + index);
    const snapshot = { trackerKey: tracker, externalId: String(index), title, url, magnet: `magnet:?xt=urn:btih:${"a".repeat(40)}`, torrentUrl: url, fingerprint: "fp", metadata: { snapshotVersion: 1 } };
    sub.run(id, userId, collection, "direct", title, url, "[]", "[]", index === 5 ? 0 : 1, index === 6 ? 0 : 1, index === 6 ? null : ago(12 + index * 7), ago(120 + index * 30),
      index === 3 ? "Kinozal login required: credentials are missing" : null, JSON.stringify(snapshot), 0, ago(9000), ago(100));
    track.run(id, tracker); state.run(id, tracker);
    if (index !== 6) for (let e = 0; e < (index % 4) + 1; e += 1) {
      // Direct-change payloads: e=0 title+magnet, e=1 torrent file, e=2 cover+metadata, e=3 an older event without snapshots.
      const previousTitle = title.replace(/(\d+) из (\d+)/, (_, done, all) => `${Number(done) - 2} из ${all}`).replace("2160p", "1080p").replace(" WEB-DL", " WEBRip");
      const previous = { ...snapshot, title: e === 0 ? previousTitle : title, magnet: e === 0 ? `magnet:?xt=urn:btih:${"b".repeat(40)}` : snapshot.magnet, torrentUrl: e === 1 ? `${url}&old=1` : url };
      const changes = [["title changed", "magnet changed"], ["torrent file changed"], ["cover changed", "metadata changed"], ["metadata changed"]][e % 4];
      const payload = e === 3 ? { changes } : { previous, current: snapshot, changes };
      event.run(`e${n++}`, id, userId, "direct-change", changes.join(", "), JSON.stringify(payload), ago(60 * (e + 1) * (index + 1) + (e === 0 ? 0 : 1500)), (index % 2 === 0 || index === 7) && e === 0 ? null : ago(10));
    }
  }
  const rules: Array<[string, string, string[], string[], Array<(typeof TRACKERS)[number]>]> = [
    ["r0", "series", ["Severance", "2160p"], ["Trailer", "Трейлер"], ["rutracker", "kinozal", "rutor"]],
    ["r1", "series", ["Одни из нас"], ["Teaser", "Soundtrack", "Саундтрек"], ["rutracker"]],
    ["r2", "films", ["Nolan", "Remux"], [], ["kinozal", "rutor"]],
    ["r3", "docs", ["BBC Earth"], ["Trailer"], ["rutracker", "rutor"]],
  ];
  for (const [index, [id, collection, required, ignored, keys]] of rules.entries()) {
    sub.run(id, userId, collection, "rule", required.join(" "), null, JSON.stringify(required), JSON.stringify(ignored), 1, 1, ago(9 + index), ago(300), index === 3 ? "RuTracker returned HTTP 503" : null, null, 0, ago(9000), ago(100));
    for (const key of keys) { track.run(id, key); state.run(id, key); }
    const release = (m: number) => ({ trackerKey: keys[m % keys.length], externalId: `${id}${m}`, title: `${required.join(" ")} — release ${m + 1} WEB-DL 1080p`, url: trackerUrl("rutracker", 7000 + m),
      magnet: m % 2 === 0 ? `magnet:?xt=urn:btih:${String(m).repeat(40)}` : undefined, torrentUrl: m < 2 ? `https://rutracker.org/forum/dl.php?t=${7000 + m}` : undefined });
    for (let m = 0; m < 4 - index; m += 1) { const item = release(m); match.run(`${id}m${m}`, id, item.trackerKey, item.externalId, item.title, item.url, item.magnet ?? null, item.torrentUrl ?? null, ago(60 * (m + 2))); }
    const released = Array.from({ length: [1, 7, 2, 1][index] }, (_, m) => release(m));
    event.run(`e${n++}`, id, userId, "rule-match", released.length === 1 ? `New match: ${released[0].title}` : "New matches", JSON.stringify({ releases: released }), ago(90 + index * 400), index === 1 ? ago(10) : null);
  }
  for (let index = 0; index < 34; index += 1) {
    const id = `a${index}`, title = `Archived release ${index + 1} / Архивный релиз ${index + 1} (${2010 + (index % 15)}) BDRip 720p`, url = trackerUrl("rutor", 800_000 + index);
    sub.run(id, userId, "archive", "direct", title, url, "[]", "[]", 1, 1, ago(30 + index), index % 5 === 4 ? null : ago(5000 + index * 60), null,
      JSON.stringify({ trackerKey: "rutor", externalId: String(index), title, url, fingerprint: "fp", metadata: {} }), index % 9 === 0 ? 1 : 0, ago(9000), ago(100));
    track.run(id, "rutor"); state.run(id, "rutor");
    if (index === 0) event.run(`e${n++}`, id, userId, "direct-change", "torrent file changed", JSON.stringify({ previous: { title, url, torrentUrl: `${url}?old` }, current: { title, url, torrentUrl: url }, changes: ["torrent file changed"] }), ago(4000), ago(3000));
  }
  // An event recorded before change snapshots existed: only a summary.
  event.run(`e${n++}`, "d1", userId, "direct-change", "Release changed", "{}", ago(20000), ago(19000));
})();

// Administration: a second account, tracker access, paged tracker logs, Telegram deliveries and a queue.
db.transaction(() => {
  db.prepare("INSERT INTO users (id, username, password_hash, is_admin, must_change_password, created_at, updated_at) VALUES ('maria', 'maria', ?, 0, 0, ?, ?)").run(hashSync("Maria-Example-2026", 10), ago(20000), ago(20000));
  db.prepare("INSERT INTO collections (id, user_id, name, created_at, updated_at) VALUES ('maria-inbox', 'maria', 'Inbox', ?, ?)").run(ago(20000), ago(20000));
  db.prepare(`INSERT INTO subscriptions (id, user_id, collection_id, type, name, required_terms, ignored_terms, enabled, initialized, created_at, updated_at)
    VALUES ('m1', 'maria', 'maria-inbox', 'rule', '', '["Foundation","2160p"]', '[]', 1, 1, ?, ?)`).run(ago(9000), ago(100));
  db.prepare("INSERT INTO subscription_trackers (subscription_id, tracker_key) VALUES ('m1', 'rutracker')").run();
  db.prepare("INSERT INTO user_tracker_mirrors (user_id, tracker_key, base_url, updated_at) VALUES (?, 'rutracker', 'https://rutracker.net', ?)").run(userId, ago(500));
  db.prepare("UPDATE tracker_mirrors SET base_url = 'https://rutor.info' WHERE tracker_key = 'rutor'").run();
  const runId = startSchedulerRun(db, "schedule", ago(400));
  const subscriptions = ["d0", "d1", "d2", "r0", "r1", "a3", "m1"];
  const outcomes = ["unchanged", "unchanged", "changed", "unchanged", "new-matches", "error", "temporarily-unavailable", "unchanged", "network"];
  for (let index = 0; index < 57; index += 1) {
    const trackerKey = TRACKERS[index % 3], outcome = outcomes[index % outcomes.length], subscriptionId = subscriptions[index % subscriptions.length];
    const failed = ["error", "network", "temporarily-unavailable"].includes(outcome), rule = subscriptionId.startsWith("r") || subscriptionId === "m1";
    recordTrackerObservation(db, { runId, userId: subscriptionId === "m1" ? "maria" : userId, subscriptionId, trackerKey, operation: rule ? "rule-discovery" : "direct", outcome,
      requestedUrl: trackerUrl(trackerKey, (trackerKey === "rutracker" ? 6_500_100 : trackerKey === "kinozal" ? 2_000_100 : 900_100) + index),
      durationMs: 180 + (index * 37) % 900, releaseCount: failed ? undefined : 1 + (index % 4),
      error: failed ? new Error(outcome === "network" ? "Connection reset by peer" : outcome === "error" ? "Unexpected page layout" : "Tracker answered HTTP 503") : undefined,
      details: rule ? { requiredTerms: subscriptionId === "m1" ? "Foundation + 2160p" : "Severance + 2160p", matchedCount: index % 3, newMatchCount: index % 2 } : undefined,
      observedAt: ago(3 + index * 9) });
  }
  for (let index = 0; index < 26; index += 1) {
    const subscriptionId = ["d0", "r0", "d2", "m1", "a3"][index % 5], failed = index % 7 === 3;
    recordTelegramDelivery(db, { userId: subscriptionId === "m1" ? "maria" : userId, subscriptionId, trackerKey: TRACKERS[index % 3], externalId: String(6_500_200 + index),
      title: `Example release ${index + 1} WEB-DL 1080p`, deliveryMethod: index % 4 === 0 ? "photo-upload" : index % 4 === 1 ? "photo-cache" : "text", outcome: failed ? "failed" : "delivered",
      telegramMessageId: failed ? undefined : 4100 + index, error: failed ? "Telegram API returned 429 Too Many Requests" : undefined, durationMs: 140 + index * 11, createdAt: ago(5 + index * 23) });
  }
  const queue = db.prepare("INSERT INTO notification_queue (id, dedupe_key, user_id, subscription_id, payload, attempts, next_attempt_at, lease_until, last_error, created_at) VALUES (?, ?, ?, ?, '{}', ?, ?, ?, ?, ?)");
  queue.run("q1", "q1", userId, "r0", 2, ago(-4), null, "Telegram API returned 429 Too Many Requests", ago(30));
  queue.run("q2", "q2", "maria", "m1", 0, ago(-1), ago(-1), null, ago(2));
  queue.run("q3", "q3", userId, "d1", 4, ago(-25), null, "Connection reset by peer", ago(90));
})();
// A queue row whose subscription no longer exists (older data; rows are normally removed with the subscription).
db.pragma("foreign_keys = OFF");
db.prepare("INSERT INTO notification_queue (id, dedupe_key, user_id, subscription_id, payload, attempts, next_attempt_at, last_error, created_at) VALUES ('q4', 'q4', ?, '412', '{}', 1, ?, 'Chat not found', ?)").run(userId, ago(-12), ago(60));
db.pragma("foreign_keys = ON");
writeTrackerCredentials(db, vault, userId, "rutracker", { username: "example_keeper", password: "fictional-tracker-password" });

// Checks never reach a tracker.
for (const manifest of trackerRegistry.manifests()) {
  const plugin = trackerRegistry.get(manifest.key)!;
  if (plugin.direct) plugin.direct.fetchSnapshot = async (url) => ({ trackerKey: manifest.key, externalId: "1", title: "Updated example release", url, fingerprint: "fp", metadata: { snapshotVersion: manifest.snapshotVersion } });
  if (plugin.rules) plugin.rules.discover = async () => ({ releases: [], coverage: { source: "search", complete: true } });
}

await app.register(fastifyStatic, { root: publicDir, wildcard: false });
app.setNotFoundHandler(async (request, reply) => request.url.startsWith("/api/") ? reply.code(404).send({ error: "Not found" }) : reply.type("text/html").sendFile("index.html"));
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  try { await app.close(); } finally { rmSync(dataDir, { recursive: true, force: true }); }
}
for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => void stop());
try { await app.listen({ host: "127.0.0.1", port }); }
catch (error) { await stop(); throw error; }
console.log(`UI fixture: http://127.0.0.1:${port} (admin / admin)`);
