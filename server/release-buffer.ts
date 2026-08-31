import type { SqliteDatabase } from "./db.js";
import { nowIso } from "./db.js";
import type { DiscoveryBatch } from "./trackers/core/contracts.js";
import type { Release, TrackerKey } from "./types.js";

const BUFFER_RETENTION_DAYS = 14;

interface FeedStateRow {
  tracker_key: TrackerKey;
  fetched_at: string;
  entry_count: number;
  oldest_entry_at: string | null;
  newest_entry_at: string | null;
  previous_entry_ids: string;
  overlap_count: number | null;
  new_entry_count: number;
  coverage_minutes: number | null;
  coverage_status: string;
  last_continuous_at: string | null;
  unresolved_gap_since: string | null;
  last_gap_at: string | null;
  recovered_at: string | null;
  last_recovery_attempt_at: string | null;
}

interface BufferedReleaseRow {
  tracker_key: TrackerKey;
  external_id: string;
  title: string;
  url: string;
  magnet: string | null;
  torrent_url: string | null;
  published_at: string | null;
  metadata: string;
}

export interface RollingFeedResult {
  trackerKey: TrackerKey;
  fetchedAt: string;
  entryCount: number;
  overlapCount?: number;
  newEntryCount: number;
  oldestEntryAt?: string;
  newestEntryAt?: string;
  coverageMinutes?: number;
  coverageStatus: "baseline" | "continuous" | "gap" | "recovered";
  gapDetected: boolean;
  unresolvedGapSince?: string;
  bufferedCount: number;
}

export interface FeedHealth {
  trackerKey: TrackerKey;
  fetchedAt: string;
  entryCount: number;
  overlapCount?: number;
  newEntryCount: number;
  oldestEntryAt?: string;
  newestEntryAt?: string;
  coverageMinutes?: number;
  coverageStatus: string;
  lastContinuousAt?: string;
  unresolvedGapSince?: string;
  lastGapAt?: string;
  recoveredAt?: string;
  lastRecoveryAttemptAt?: string;
  pollingIntervalMinutes: number;
  safetyMargin?: number;
}

export function ingestRollingFeedBatch(
  db: SqliteDatabase,
  trackerKey: TrackerKey,
  batch: DiscoveryBatch,
  fetchedAt = nowIso(),
): RollingFeedResult {
  return db.transaction(() => {
    const previous = feedStateRow(db, trackerKey);
    const previousIds = jsonStringArray(previous?.previous_entry_ids);
    const currentIds = [...new Set(batch.releases.map((release) => release.externalId))];
    const previousSet = new Set(previousIds);
    const overlapCount = previous ? currentIds.filter((id) => previousSet.has(id)).length : undefined;
    const newEntryCount = previous ? currentIds.length - (overlapCount || 0) : currentIds.length;
    const gapDetected = Boolean(previous && previousIds.length > 0 && currentIds.length > 0 && overlapCount === 0);
    const timestamps = batch.releases
      .map((release) => release.publishedAt)
      .filter((value): value is string => typeof value === "string" && Number.isFinite(Date.parse(value)))
      .sort();
    const oldestEntryAt = batch.coverage.oldestObservedAt || timestamps[0];
    const newestEntryAt = batch.cursor || timestamps.at(-1);
    const coverageMinutes = durationMinutes(oldestEntryAt, newestEntryAt);
    const unresolvedGapSince = previous?.unresolved_gap_since
      || (gapDetected ? previous?.fetched_at : undefined)
      || undefined;
    const coverageStatus: RollingFeedResult["coverageStatus"] = unresolvedGapSince
      ? "gap"
      : previous
        ? "continuous"
        : "baseline";

    bufferReleases(db, batch.releases, fetchedAt);
    db.prepare(`
      INSERT INTO tracker_feed_state (
        tracker_key, fetched_at, entry_count, oldest_entry_at, newest_entry_at,
        previous_entry_ids, overlap_count, new_entry_count, coverage_minutes,
        coverage_status, last_continuous_at, unresolved_gap_since, last_gap_at,
        recovered_at, last_recovery_attempt_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(tracker_key) DO UPDATE SET
        fetched_at = excluded.fetched_at,
        entry_count = excluded.entry_count,
        oldest_entry_at = excluded.oldest_entry_at,
        newest_entry_at = excluded.newest_entry_at,
        previous_entry_ids = excluded.previous_entry_ids,
        overlap_count = excluded.overlap_count,
        new_entry_count = excluded.new_entry_count,
        coverage_minutes = excluded.coverage_minutes,
        coverage_status = excluded.coverage_status,
        last_continuous_at = excluded.last_continuous_at,
        unresolved_gap_since = excluded.unresolved_gap_since,
        last_gap_at = excluded.last_gap_at,
        recovered_at = excluded.recovered_at,
        last_recovery_attempt_at = excluded.last_recovery_attempt_at
    `).run(
      trackerKey,
      fetchedAt,
      currentIds.length,
      oldestEntryAt || null,
      newestEntryAt || null,
      JSON.stringify(currentIds),
      overlapCount ?? null,
      newEntryCount,
      coverageMinutes ?? null,
      coverageStatus,
      gapDetected ? previous?.last_continuous_at || previous?.fetched_at || null : fetchedAt,
      unresolvedGapSince || null,
      gapDetected ? fetchedAt : previous?.last_gap_at || null,
      previous?.recovered_at || null,
      previous?.last_recovery_attempt_at || null,
    );
    pruneReleaseBuffer(db, fetchedAt);
    const bufferedCount = Number((db.prepare(`
      SELECT COUNT(*) AS count FROM tracker_release_buffer WHERE tracker_key = ?
    `).get(trackerKey) as { count: number }).count);
    return {
      trackerKey,
      fetchedAt,
      entryCount: currentIds.length,
      overlapCount,
      newEntryCount,
      oldestEntryAt,
      newestEntryAt,
      coverageMinutes,
      coverageStatus,
      gapDetected,
      unresolvedGapSince,
      bufferedCount,
    };
  })();
}

export function bufferReleases(db: SqliteDatabase, releases: Release[], observedAt = nowIso()): void {
  const statement = db.prepare(`
    INSERT INTO tracker_release_buffer (
      tracker_key, external_id, title, url, magnet, torrent_url, published_at,
      metadata, first_seen_at, last_seen_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(tracker_key, external_id) DO UPDATE SET
      title = excluded.title,
      url = excluded.url,
      magnet = COALESCE(excluded.magnet, tracker_release_buffer.magnet),
      torrent_url = COALESCE(excluded.torrent_url, tracker_release_buffer.torrent_url),
      published_at = COALESCE(excluded.published_at, tracker_release_buffer.published_at),
      metadata = excluded.metadata,
      last_seen_at = excluded.last_seen_at
  `);
  for (const release of releases) {
    statement.run(
      release.trackerKey,
      release.externalId,
      release.title,
      release.url,
      release.magnet || null,
      release.torrentUrl || null,
      release.publishedAt || null,
      JSON.stringify(release.metadata || {}),
      observedAt,
      observedAt,
    );
  }
}

export function bufferedReleases(db: SqliteDatabase, trackerKey: TrackerKey): Release[] {
  const rows = db.prepare(`
    SELECT tracker_key, external_id, title, url, magnet, torrent_url, published_at, metadata
    FROM tracker_release_buffer
    WHERE tracker_key = ?
    ORDER BY COALESCE(published_at, first_seen_at) DESC
  `).all(trackerKey) as BufferedReleaseRow[];
  return rows.map((row) => ({
    trackerKey: row.tracker_key,
    externalId: row.external_id,
    title: row.title,
    url: row.url,
    magnet: row.magnet || undefined,
    torrentUrl: row.torrent_url || undefined,
    publishedAt: row.published_at || undefined,
    metadata: jsonObject(row.metadata),
  }));
}

export function markFeedRecovery(db: SqliteDatabase, trackerKey: TrackerKey, complete: boolean, attemptedAt = nowIso()): void {
  db.prepare(`
    UPDATE tracker_feed_state
    SET coverage_status = CASE WHEN ? = 1 THEN 'recovered' ELSE 'gap' END,
        unresolved_gap_since = CASE WHEN ? = 1 THEN NULL ELSE unresolved_gap_since END,
        recovered_at = CASE WHEN ? = 1 THEN ? ELSE recovered_at END,
        last_continuous_at = CASE WHEN ? = 1 THEN ? ELSE last_continuous_at END,
        last_recovery_attempt_at = ?
    WHERE tracker_key = ?
  `).run(
    complete ? 1 : 0,
    complete ? 1 : 0,
    complete ? 1 : 0,
    attemptedAt,
    complete ? 1 : 0,
    attemptedAt,
    attemptedAt,
    trackerKey,
  );
}

export function feedHealth(db: SqliteDatabase, pollingIntervalMinutes: number): FeedHealth[] {
  const rows = db.prepare(`
    SELECT * FROM tracker_feed_state ORDER BY tracker_key
  `).all() as FeedStateRow[];
  return rows.map((row) => ({
    trackerKey: row.tracker_key,
    fetchedAt: row.fetched_at,
    entryCount: row.entry_count,
    overlapCount: row.overlap_count ?? undefined,
    newEntryCount: row.new_entry_count,
    oldestEntryAt: row.oldest_entry_at || undefined,
    newestEntryAt: row.newest_entry_at || undefined,
    coverageMinutes: row.coverage_minutes ?? undefined,
    coverageStatus: row.coverage_status,
    lastContinuousAt: row.last_continuous_at || undefined,
    unresolvedGapSince: row.unresolved_gap_since || undefined,
    lastGapAt: row.last_gap_at || undefined,
    recoveredAt: row.recovered_at || undefined,
    lastRecoveryAttemptAt: row.last_recovery_attempt_at || undefined,
    pollingIntervalMinutes,
    safetyMargin: row.coverage_minutes === null
      ? undefined
      : Math.round(row.coverage_minutes / pollingIntervalMinutes * 10) / 10,
  }));
}

function feedStateRow(db: SqliteDatabase, trackerKey: TrackerKey): FeedStateRow | undefined {
  return db.prepare("SELECT * FROM tracker_feed_state WHERE tracker_key = ?").get(trackerKey) as FeedStateRow | undefined;
}

function pruneReleaseBuffer(db: SqliteDatabase, now: string): void {
  const cutoff = new Date(Date.parse(now) - BUFFER_RETENTION_DAYS * 24 * 60 * 60 * 1_000).toISOString();
  db.prepare("DELETE FROM tracker_release_buffer WHERE last_seen_at < ?").run(cutoff);
}

function durationMinutes(oldest: string | undefined, newest: string | undefined): number | undefined {
  if (!oldest || !newest) return undefined;
  const value = (Date.parse(newest) - Date.parse(oldest)) / 60_000;
  return Number.isFinite(value) && value >= 0 ? Math.round(value * 10) / 10 : undefined;
}

function jsonStringArray(value: string | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function jsonObject(value: string): Record<string, string | number | boolean | null> {
  try {
    const parsed = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string | number | boolean | null] => (
      entry[1] === null || ["string", "number", "boolean"].includes(typeof entry[1])
    )));
  } catch {
    return {};
  }
}
