import { nanoid } from "nanoid";
import type { SqliteDatabase } from "./db.js";
import type { Release, TrackerKey } from "./types.js";
import { TrackerError } from "./trackers/core/errors.js";

export const DIAGNOSTIC_RETENTION_HOURS = 168;
export const DIAGNOSTIC_CLEANUP_INTERVAL_MS = 60_000;

type DiagnosticDetail = string | number | boolean | null;

export interface TrackerObservationInput {
  runId: string;
  subscriptionId?: string;
  userId: string;
  trackerKey: TrackerKey;
  operation: "direct" | "rule-discovery" | "rule-enrichment";
  outcome: string;
  requestedUrl?: string;
  snapshot?: Release & { fingerprint?: string };
  releaseCount?: number;
  durationMs: number;
  error?: unknown;
  details?: Record<string, DiagnosticDetail>;
  observedAt?: string;
}

export interface TelegramDeliveryInput {
  userId: string;
  subscriptionId?: string;
  trackerKey?: TrackerKey;
  externalId?: string;
  title?: string;
  deliveryMethod: "none" | "text" | "photo-url" | "photo-upload" | "photo-cache";
  outcome: "delivered" | "failed" | "skipped";
  telegramMessageId?: number;
  durationMs: number;
  error?: unknown;
  artworkError?: unknown;
  createdAt?: string;
}

export function startSchedulerRun(db: SqliteDatabase, trigger: string, startedAt: string): string {
  pruneDiagnostics(db);
  const id = nanoid();
  db.prepare(`
    INSERT INTO scheduler_runs (id, trigger, started_at) VALUES (?, ?, ?)
  `).run(id, truncate(trigger, 40), startedAt);
  return id;
}

export function finishSchedulerRun(
  db: SqliteDatabase,
  runId: string,
  finishedAt: string,
  status: { checked: number; changed: number; errors: number },
  durationMs: number,
): void {
  db.prepare(`
    UPDATE scheduler_runs
    SET finished_at = ?, checked = ?, changed = ?, errors = ?, duration_ms = ?
    WHERE id = ?
  `).run(finishedAt, status.checked, status.changed, status.errors, Math.max(0, Math.round(durationMs)), runId);
  pruneDiagnostics(db);
}

export function recordTrackerObservation(db: SqliteDatabase, input: TrackerObservationInput): void {
  const diagnosticError = errorFields(input.error);
  const snapshot = input.snapshot;
  db.prepare(`
    INSERT INTO tracker_observations (
      id, run_id, subscription_id, user_id, tracker_key, operation, outcome,
      requested_url, resolved_url, http_status, external_id, title, fingerprint,
      has_cover, has_magnet, has_torrent_file, release_count, duration_ms,
      error_code, error_message, details, observed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    nanoid(),
    input.runId,
    input.subscriptionId || null,
    input.userId,
    input.trackerKey,
    input.operation,
    truncate(input.outcome, 40),
    safeDiagnosticUrl(input.requestedUrl) || null,
    safeDiagnosticUrl(diagnosticError.url || snapshot?.url) || null,
    diagnosticError.status || null,
    snapshot?.externalId ? truncate(snapshot.externalId, 120) : null,
    snapshot?.title ? truncate(snapshot.title, 500) : null,
    snapshot?.fingerprint ? truncate(snapshot.fingerprint, 200) : null,
    snapshot ? (snapshot.coverUrl ? 1 : 0) : null,
    snapshot ? (snapshot.magnet ? 1 : 0) : null,
    snapshot ? (snapshot.torrentUrl ? 1 : 0) : null,
    input.releaseCount ?? null,
    Math.max(0, Math.round(input.durationMs)),
    diagnosticError.code,
    diagnosticError.message,
    JSON.stringify({ ...snapshotDetails(snapshot), ...safeObservationDetails(input.details) }),
    input.observedAt || new Date().toISOString(),
  );
}

export function recordTelegramDelivery(db: SqliteDatabase, input: TelegramDeliveryInput): void {
  db.prepare(`
    INSERT INTO telegram_deliveries (
      id, user_id, subscription_id, tracker_key, external_id, title,
      delivery_method, outcome, telegram_message_id, error_message, artwork_error_message, duration_ms, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    nanoid(),
    input.userId,
    input.subscriptionId || null,
    input.trackerKey || null,
    input.externalId ? truncate(input.externalId, 120) : null,
    input.title ? truncate(input.title, 500) : null,
    input.deliveryMethod,
    input.outcome,
    input.telegramMessageId ?? null,
    input.error ? safeDiagnosticText(input.error instanceof Error ? input.error.message : String(input.error)) : null,
    input.artworkError ? safeDiagnosticText(input.artworkError instanceof Error ? input.artworkError.message : String(input.artworkError)) : null,
    Math.max(0, Math.round(input.durationMs)),
    input.createdAt || new Date().toISOString(),
  );
}

export function diagnosticCutoffIso(now = Date.now()): string {
  return new Date(now - DIAGNOSTIC_RETENTION_HOURS * 60 * 60 * 1_000).toISOString();
}

export function pruneDiagnostics(db: SqliteDatabase, now = Date.now()): { observations: number; runs: number; deliveries: number } {
  const cutoff = diagnosticCutoffIso(now);
  return db.transaction(() => {
    const observations = db.prepare("DELETE FROM tracker_observations WHERE observed_at < ?").run(cutoff).changes;
    const deliveries = db.prepare("DELETE FROM telegram_deliveries WHERE created_at < ?").run(cutoff).changes;
    const runs = db.prepare(`
      DELETE FROM scheduler_runs
      WHERE COALESCE(finished_at, started_at) < ?
    `).run(cutoff).changes;
    return { observations, runs, deliveries };
  })();
}

function errorFields(error: unknown): { code: string | null; message: string | null; status?: number; url?: string } {
  if (!error) return { code: null, message: null };
  if (error instanceof TrackerError) {
    return {
      code: error.code,
      message: safeDiagnosticText(error.message),
      status: error.status,
      url: error.url,
    };
  }
  return {
    code: error instanceof Error ? truncate(error.name || "error", 80) : "error",
    message: safeDiagnosticText(error instanceof Error ? error.message : String(error)),
  };
}

function snapshotDetails(snapshot: Release | undefined): Record<string, DiagnosticDetail> {
  if (!snapshot) return {};
  const details: Record<string, DiagnosticDetail> = {};
  if (snapshot.publishedAt) details.publishedAt = truncate(snapshot.publishedAt, 80);
  const metadata = snapshot.metadata;
  if (!metadata) return details;
  for (const key of ["snapshotVersion", "coverObserved", "changeMarker", "size", "category", "feedSeen", "detailSource", "updated"]) {
    const value = metadata[key];
    if (typeof value === "string") details[key] = truncate(value, 200);
    else if (typeof value === "number" || typeof value === "boolean" || value === null) details[key] = value;
  }
  return details;
}

function safeObservationDetails(details: Record<string, DiagnosticDetail> | undefined): Record<string, DiagnosticDetail> {
  if (!details) return {};
  const safe: Record<string, DiagnosticDetail> = {};
  for (const key of [
    "subscriptionCount",
    "matchedCount",
    "newMatchCount",
    "baselineCount",
    "requiredTerms",
    "discoveryRevision",
    "coverCacheStatus",
    "coverCacheBytes",
    "coverCachedAt",
    "coverCacheFallback",
    "coverCacheError",
    "feedEntryCount",
    "feedNewEntryCount",
    "feedOverlapCount",
    "feedBufferedCount",
    "feedCoverageMinutes",
    "feedCoverageStatus",
    "feedOldestEntryAt",
    "feedNewestEntryAt",
    "recoveryCount",
    "recoveryComplete",
  ]) {
    const value = details[key];
    if (typeof value === "string") safe[key] = truncate(value, 200);
    else if (typeof value === "number" || typeof value === "boolean" || value === null) safe[key] = value;
  }
  return safe;
}

function safeDiagnosticText(value: string): string {
  const sanitized = value
    .replace(/https?:\/\/[^\s"'<>]+/giu, (url) => safeDiagnosticUrl(url) || "[redacted URL]")
    .replace(/\b(token|api[_-]?key|password|secret|authorization)(\s*[=:]\s*)[^\s,;]+/giu, "$1$2[redacted]");
  return truncate(sanitized, 500);
}

function safeDiagnosticUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/token|key|pass|auth|secret|session|cookie/i.test(key) && key.toLocaleLowerCase("en-US") !== "tracker") {
        url.searchParams.set(key, "[redacted]");
      }
    }
    return truncate(url.toString(), 2_000);
  } catch {
    return undefined;
  }
}

function truncate(value: string, maximumLength: number): string {
  return value.length <= maximumLength ? value : `${value.slice(0, maximumLength - 1)}…`;
}
