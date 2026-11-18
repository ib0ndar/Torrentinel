import { nowIso, type SqliteDatabase } from "./db.js";
import type { TrackerKey } from "./types.js";

export function normalizeTerms(terms: string[]): string[] {
  return [...new Set(terms.map((term) => term.trim()).filter(Boolean))];
}

export function insertSubscription(db: SqliteDatabase, input: {
  userId: string; collectionId: string; trackerKeys: TrackerKey[]; enabled?: boolean;
} & ({ type: "direct"; url: string } | { type: "rule"; requiredTerms: string[]; ignoredTerms: string[] })): string {
  const { id } = db.prepare(`SELECT CAST(COALESCE(MAX(CAST(id AS INTEGER)), 0) + 1 AS TEXT) AS id
    FROM subscriptions WHERE id <> '' AND id NOT GLOB '*[^0-9]*'`).get() as { id: string };
  const timestamp = nowIso();
  db.prepare(`INSERT INTO subscriptions (id, user_id, collection_id, type, name, direct_url, required_terms,
    ignored_terms, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?)`).run(
    id, input.userId, input.collectionId, input.type, input.type === "direct" ? input.url : null,
    JSON.stringify(input.type === "rule" ? normalizeTerms(input.requiredTerms) : []),
    JSON.stringify(input.type === "rule" ? normalizeTerms(input.ignoredTerms) : []), input.enabled === false ? 0 : 1, timestamp, timestamp,
  );
  const tracker = db.prepare("INSERT INTO subscription_trackers (subscription_id, tracker_key) VALUES (?, ?)");
  const state = db.prepare("INSERT INTO subscription_tracker_state (subscription_id, tracker_key) VALUES (?, ?)");
  for (const key of new Set(input.trackerKeys)) {
    tracker.run(id, key);
    state.run(id, key);
  }
  return id;
}

// Use the topic identifier across tracker mirrors, slugs and incidental query parameters.
export function topicId(tracker: TrackerKey, value: string): string | undefined {
  let url: URL;
  try { url = new URL(value); } catch { return; }
  const path = url.pathname;
  const id = tracker === "rutor" ? /^\/torrent\/(\d+)(?:\/|$)/i.exec(path)?.[1]
    : tracker === "kinozal" ? (/^\/details\.php$/i.test(path) ? url.searchParams.get("id") : null)
    : /^(?:\/forum)?\/viewtopic\.php$/i.test(path) ? url.searchParams.get("t") : null;
  return id && /^\d+$/.test(id) ? id.replace(/^0+(?=\d)/, "") : undefined;
}

export function publicTopicUrl(tracker: TrackerKey, id: string): string {
  switch (tracker) {
    case "kinozal": return `https://kinozal.tv/details.php?id=${id}`;
    case "rutor": return `https://rutor.info/torrent/${id}`;
    case "rutracker": return `https://rutracker.org/forum/viewtopic.php?t=${id}`;
  }
}

export function watchedTopics(db: SqliteDatabase, userId: string) {
  const rows = db.prepare(`SELECT s.id, s.direct_url, st.tracker_key FROM subscriptions s
    JOIN subscription_trackers st ON st.subscription_id = s.id WHERE s.user_id = ? AND s.type = 'direct'
    ORDER BY s.enabled DESC, s.rowid`).all(userId) as { id: string; direct_url: string; tracker_key: TrackerKey }[];
  const topics = new Map<string, string>();
  for (const row of rows) {
    const id = topicId(row.tracker_key, row.direct_url);
    if (id && !topics.has(`${row.tracker_key}:${id}`)) topics.set(`${row.tracker_key}:${id}`, row.id);
  }
  return topics;
}
