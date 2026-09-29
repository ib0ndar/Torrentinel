// Run from the project root: npm run benchmark:refactoring
// Synthetic, local-only microbenchmarks; not end-to-end scheduler timings.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { createDatabase } from "../server/db.ts";
import { compileTitleMatcher, normalizeTitle } from "../server/rule-matching.ts";

function medianTiming(work) {
  work();
  const samples = Array.from({ length: 7 }, () => {
    const started = performance.now();
    work();
    return performance.now() - started;
  }).sort((a, b) => a - b);
  return samples[3];
}

function compare(name, before, after, fixture) {
  assert.deepEqual(after(), before());
  const beforeMs = medianTiming(before);
  const afterMs = medianTiming(after);
  return { name, fixture, beforeMs: +beforeMs.toFixed(3), afterMs: +afterMs.toFixed(3), speedup: +(beforeMs / afterMs).toFixed(1) };
}

const titles = Array.from({ length: 500 }, (_, index) => `СЕРИАЛ Show ${index} WEB-DL 2160P${index % 10 === 0 ? " Trailer" : ""}`);
const rules = Array.from({ length: 250 }, () => ({ required: ["сериал", "show", "web-dl", "2160p"], ignored: ["trailer", "teaser"] }));
function previousMatching() {
  return rules.map(({ required, ignored }) => titles.filter((title) => {
    const normalized = title.toLocaleLowerCase("ru-RU");
    return required.every((term) => normalized.includes(term.toLocaleLowerCase("ru-RU")))
      && !ignored.some((term) => normalized.includes(term.toLocaleLowerCase("ru-RU")));
  }).length);
}
function compiledMatching() {
  const normalized = titles.map(normalizeTitle);
  return rules.map(({ required, ignored }) => {
    const matches = compileTitleMatcher(required, ignored);
    return titles.filter((_, index) => matches(normalized[index])).length;
  });
}

const results = [compare("Rule matching", previousMatching, compiledMatching, "250 rules × 500 titles; 4 required, 2 ignored phrases")];
const db = createDatabase(":memory:");
try {
  const timestamp = new Date().toISOString();
  const insertUser = db.prepare(`INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (?, ?, 'unused', ?, ?)`);
  const insertCollection = db.prepare(`INSERT INTO collections (id, user_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`);
  const insertSubscription = db.prepare(`INSERT INTO subscriptions (id, user_id, collection_id, type, name, created_at, updated_at) VALUES (?, ?, ?, 'rule', '', ?, ?)`);
  db.transaction(() => {
    for (let user = 0; user < 40; user += 1) {
      const userId = `fixture-user-${user}`;
      insertUser.run(userId, userId, timestamp, timestamp);
      for (let collection = 0; collection < 20; collection += 1) {
        insertCollection.run(`${userId}-c${collection}`, userId, `Collection ${collection}`, timestamp, timestamp);
      }
      for (let subscription = 0; subscription < 200; subscription += 1) {
        insertSubscription.run(`${userId}-s${subscription}`, userId, `${userId}-c${subscription % 20}`, timestamp, timestamp);
      }
    }
  })();
  const before = db.prepare(`
    SELECT u.id, u.username, u.is_admin, u.disabled, u.must_change_password, u.created_at,
           COUNT(DISTINCT c.id) AS collection_count, COUNT(DISTINCT s.id) AS subscription_count
    FROM users u
    LEFT JOIN collections c ON c.user_id = u.id
    LEFT JOIN subscriptions s ON s.user_id = u.id
    GROUP BY u.id ORDER BY u.created_at
  `);
  const routes = readFileSync(new URL("../server/routes.ts", import.meta.url), "utf8");
  const query = routes.match(/app\.get\("\/api\/admin\/users"[\s\S]*?db\.prepare\(`([\s\S]*?)`\)/)?.[1];
  assert.ok(query, "Could not locate the production admin user query");
  const after = db.prepare(query);
  const sortedRows = (statement) => statement.all().sort((a, b) => a.id.localeCompare(b.id));
  results.push(compare("Admin user counts", () => sortedRows(before), () => sortedRows(after), "40 users × 20 collections × 200 subscriptions, plus seeded admin"));
  console.log(JSON.stringify({ node: process.version, samples: 7, statistic: "median", results }, null, 2));
} finally {
  db.close();
}
