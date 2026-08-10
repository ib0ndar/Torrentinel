import { nanoid } from "nanoid";
import type { SqliteDatabase } from "./db.js";
import { nowIso } from "./db.js";
import { config } from "./config.js";
import type { DirectSnapshot, Release, TrackerKey } from "./types.js";
import { trackerRegistry } from "./trackers/index.js";
import type { TrackerContext } from "./trackers/core/contracts.js";
import { TrackerError } from "./trackers/core/errors.js";
import type { TelegramService } from "./telegram.js";
import { readTrackerCredentials, type SecretVault } from "./secrets.js";
import {
  DIAGNOSTIC_CLEANUP_INTERVAL_MS,
  finishSchedulerRun,
  pruneDiagnostics,
  recordTrackerObservation,
  startSchedulerRun,
  type TrackerObservationInput,
} from "./diagnostics.js";

interface DirectRow {
  id: string;
  user_id: string;
  name: string;
  direct_url: string;
  initialized: number;
  current_fingerprint: string | null;
  current_snapshot: string | null;
  tracker_key: TrackerKey;
  base_url: string;
}

interface RuleRow {
  id: string;
  user_id: string;
  name: string;
  tracker_key: TrackerKey;
  required_terms: string;
  ignored_terms: string;
  base_url: string;
  tracker_initialized: number;
}

interface SchedulerStatus {
  running: boolean;
  lastStartedAt?: string;
  lastFinishedAt?: string;
  nextRunAt?: string;
  checked: number;
  changed: number;
  errors: number;
  trigger?: string;
}

export const MIN_POLL_INTERVAL_MINUTES = 5;
export const MAX_POLL_INTERVAL_MINUTES = 6 * 60;
const POLL_INTERVAL_STATE_KEY = "poll_interval_minutes";

export class Scheduler {
  private running = false;
  private started = false;
  private interval?: NodeJS.Timeout;
  private startupTimer?: NodeJS.Timeout;
  private diagnosticsCleanupTimer?: NodeJS.Timeout;
  private nextScheduledAt?: string;

  constructor(
    private readonly db: SqliteDatabase,
    private readonly telegram: TelegramService,
    private readonly vault: SecretVault,
  ) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    this.pruneDiagnostics();
    this.diagnosticsCleanupTimer = setInterval(() => this.pruneDiagnostics(), DIAGNOSTIC_CLEANUP_INTERVAL_MS);
    this.diagnosticsCleanupTimer.unref();
    this.startupTimer = setTimeout(() => void this.run("startup"), config.pollStartupDelaySeconds * 1_000);
    this.scheduleInterval();
  }

  stop(): void {
    this.started = false;
    if (this.interval) clearInterval(this.interval);
    if (this.startupTimer) clearTimeout(this.startupTimer);
    if (this.diagnosticsCleanupTimer) clearInterval(this.diagnosticsCleanupTimer);
    this.interval = undefined;
    this.startupTimer = undefined;
    this.diagnosticsCleanupTimer = undefined;
    this.nextScheduledAt = undefined;
  }

  pollIntervalMinutes(): number {
    const stored = this.db.prepare("SELECT value FROM app_state WHERE key = ?").get(POLL_INTERVAL_STATE_KEY) as
      | { value: string }
      | undefined;
    const parsed = stored ? Number.parseInt(stored.value, 10) : Number.NaN;
    if (Number.isInteger(parsed) && parsed >= MIN_POLL_INTERVAL_MINUTES && parsed <= MAX_POLL_INTERVAL_MINUTES) {
      return parsed;
    }
    return Math.min(MAX_POLL_INTERVAL_MINUTES, Math.max(MIN_POLL_INTERVAL_MINUTES, config.pollIntervalMinutes));
  }

  setPollIntervalMinutes(minutes: number): SchedulerStatus {
    if (!Number.isInteger(minutes) || minutes < MIN_POLL_INTERVAL_MINUTES || minutes > MAX_POLL_INTERVAL_MINUTES) {
      throw new RangeError(`Poll interval must be an integer between ${MIN_POLL_INTERVAL_MINUTES} and ${MAX_POLL_INTERVAL_MINUTES} minutes`);
    }
    this.db.prepare(`
      INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(POLL_INTERVAL_STATE_KEY, String(minutes), nowIso());
    if (this.started) this.scheduleInterval();
    return this.status();
  }

  status(): SchedulerStatus {
    const value = this.db.prepare("SELECT value FROM app_state WHERE key = 'scheduler_status'").get() as
      | { value: string }
      | undefined;
    if (!value) return { running: this.running, checked: 0, changed: 0, errors: 0 };
    try {
      return { ...JSON.parse(value.value) as SchedulerStatus, running: this.running };
    } catch {
      return { running: this.running, checked: 0, changed: 0, errors: 0 };
    }
  }

  async run(trigger = "manual"): Promise<SchedulerStatus> {
    if (this.running) return this.status();
    this.running = true;
    const startedMs = Date.now();
    const startedAt = nowIso();
    const runId = startSchedulerRun(this.db, trigger, startedAt);
    const status: SchedulerStatus = {
      running: true,
      lastStartedAt: startedAt,
      nextRunAt: this.nextScheduledAt,
      checked: 0,
      changed: 0,
      errors: 0,
      trigger,
    };
    this.writeStatus(status);

    try {
      await this.pollDirect(status, runId);
      await this.pollRules(status, runId);
    } finally {
      this.running = false;
      status.running = false;
      status.lastFinishedAt = nowIso();
      status.nextRunAt = this.nextScheduledAt
        || new Date(Date.now() + this.pollIntervalMinutes() * 60_000).toISOString();
      this.writeStatus(status);
      finishSchedulerRun(this.db, runId, status.lastFinishedAt, status, Date.now() - startedMs);
    }
    return status;
  }

  async checkSubscription(subscriptionId: string, userId: string): Promise<void> {
    const direct = this.directRows("AND s.id = ? AND s.user_id = ?").get(subscriptionId, userId) as DirectRow | undefined;
    if (direct) {
      const startedMs = Date.now();
      const startedAt = nowIso();
      const runId = startSchedulerRun(this.db, "subscription", startedAt);
      const status: SchedulerStatus = { running: true, checked: 0, changed: 0, errors: 0, trigger: "subscription" };
      try {
        await this.checkDirect(direct, status, runId);
      } finally {
        finishSchedulerRun(this.db, runId, nowIso(), status, Date.now() - startedMs);
      }
      return;
    }
    const type = this.db.prepare("SELECT type FROM subscriptions WHERE id = ? AND user_id = ?")
      .get(subscriptionId, userId) as { type: string } | undefined;
    if (type?.type === "rule") await this.run("subscription");
  }

  private async pollDirect(status: SchedulerStatus, runId: string): Promise<void> {
    const rows = this.directRows().all() as DirectRow[];
    for (const row of rows) await this.checkDirect(row, status, runId);
  }

  private async checkDirect(row: DirectRow, status: SchedulerStatus, runId: string): Promise<void> {
    const startedMs = Date.now();
    const plugin = trackerRegistry.get(row.tracker_key);
    let snapshot: DirectSnapshot | undefined;
    let observationError: unknown;
    let outcome = "error";
    if (!plugin?.direct) {
      const error = new TrackerError("unsupported", `${row.tracker_key} does not support direct subscriptions`, {
        trackerKey: row.tracker_key,
      });
      status.errors += 1;
      this.db.prepare(`UPDATE subscriptions SET last_checked_at = ?, last_error = ?, updated_at = ? WHERE id = ?`)
        .run(nowIso(), error.message, nowIso(), row.id);
      this.recordObservation({
        runId,
        subscriptionId: row.id,
        userId: row.user_id,
        trackerKey: row.tracker_key,
        operation: "direct",
        outcome: "unsupported",
        requestedUrl: row.direct_url,
        durationMs: Date.now() - startedMs,
        error,
      });
      return;
    }
    const checkedAt = nowIso();
    try {
      snapshot = await plugin.direct.fetchSnapshot(row.direct_url, this.context(row.user_id, row.tracker_key, row.base_url));
      status.checked += 1;
      if (!row.initialized || !row.current_fingerprint) {
        outcome = "baseline";
        this.db.prepare(`
          UPDATE subscriptions
          SET name = ?, initialized = 1, current_fingerprint = ?, current_snapshot = ?,
              last_checked_at = ?, last_error = NULL, updated_at = ?
          WHERE id = ?
        `).run(snapshot.title, snapshot.fingerprint, JSON.stringify(snapshot), checkedAt, checkedAt, row.id);
        return;
      }

      if (directSnapshotIsTemporarilyUnavailable(snapshot)) {
        outcome = "temporarily-unavailable";
        this.db.prepare(`
          UPDATE subscriptions SET last_checked_at = ?, last_error = NULL, updated_at = ? WHERE id = ?
        `).run(checkedAt, checkedAt, row.id);
        return;
      }

      if (previousDirectSnapshotWasTemporaryUnavailable(row.current_snapshot)) {
        outcome = "rebaseline";
        this.db.prepare(`
          UPDATE subscriptions
          SET name = ?, initialized = 1, current_fingerprint = ?, current_snapshot = ?,
              last_checked_at = ?, last_error = NULL, updated_at = ?
          WHERE id = ?
        `).run(
          snapshot.title, snapshot.fingerprint, JSON.stringify(snapshot),
          checkedAt, checkedAt, row.id,
        );
        return;
      }

      if (previousDirectSnapshotLacksCoverObservation(row.current_snapshot)) {
        outcome = "cover-backfill";
        this.db.prepare(`
          UPDATE subscriptions
          SET name = ?, current_fingerprint = ?, current_snapshot = ?, last_checked_at = ?,
              last_error = NULL, updated_at = ?
          WHERE id = ?
        `).run(snapshot.title, snapshot.fingerprint, JSON.stringify(snapshot), checkedAt, checkedAt, row.id);
        return;
      }

      if (directSnapshotRequiresSilentSchemaUpgrade(row.current_snapshot, snapshot)) {
        outcome = "schema-upgrade";
        this.db.prepare(`
          UPDATE subscriptions
          SET name = ?, current_fingerprint = ?, current_snapshot = ?, last_checked_at = ?,
              last_error = NULL, updated_at = ?
          WHERE id = ?
        `).run(snapshot.title, snapshot.fingerprint, JSON.stringify(snapshot), checkedAt, checkedAt, row.id);
        return;
      }

      if (snapshot.fingerprint !== row.current_fingerprint) {
        outcome = "changed";
        const currentSnapshot = snapshot;
        const previous = safeJson(row.current_snapshot);
        const changes = describeChanges(previous, currentSnapshot as unknown as Record<string, unknown>);
        const eventId = nanoid();
        this.db.transaction(() => {
          this.db.prepare(`
            UPDATE subscriptions
            SET name = ?, current_fingerprint = ?, current_snapshot = ?, last_checked_at = ?,
                last_changed_at = ?, last_error = NULL, is_updated = 1, updated_at = ?
            WHERE id = ?
          `).run(currentSnapshot.title, currentSnapshot.fingerprint, JSON.stringify(currentSnapshot), checkedAt, checkedAt, checkedAt, row.id);
          this.db.prepare(`
            INSERT INTO subscription_events
              (id, subscription_id, user_id, kind, summary, payload, created_at)
            VALUES (?, ?, ?, 'direct-change', ?, ?, ?)
          `).run(eventId, row.id, row.user_id, changes.join(", "), JSON.stringify({ previous, current: currentSnapshot, changes }), checkedAt);
        })();
        status.changed += 1;
        await this.telegram.notifyRelease(row.user_id, {
          release: currentSnapshot,
          trackerName: plugin.manifest.displayName,
          changes,
        });
      } else {
        outcome = "unchanged";
        this.db.prepare(`
          UPDATE subscriptions SET name = ?, last_checked_at = ?, last_error = NULL, updated_at = ? WHERE id = ?
        `).run(snapshot.title, checkedAt, checkedAt, row.id);
      }
    } catch (error) {
      observationError = error;
      outcome = diagnosticOutcome(error);
      status.errors += 1;
      this.db.prepare(`
        UPDATE subscriptions SET last_checked_at = ?, last_error = ?, updated_at = ? WHERE id = ?
      `).run(checkedAt, errorMessage(error), checkedAt, row.id);
    } finally {
      this.recordObservation({
        runId,
        subscriptionId: row.id,
        userId: row.user_id,
        trackerKey: row.tracker_key,
        operation: "direct",
        outcome,
        requestedUrl: row.direct_url,
        snapshot,
        durationMs: Date.now() - startedMs,
        error: observationError,
      });
    }
  }

  private async pollRules(status: SchedulerStatus, runId: string): Promise<void> {
    const rows = this.db.prepare(`
      SELECT s.id, s.user_id, s.name, st.tracker_key, s.required_terms, s.ignored_terms,
             COALESCE(utm.base_url, tm.base_url) AS base_url,
             COALESCE(sts.initialized, 0) AS tracker_initialized
      FROM subscriptions s
      JOIN subscription_trackers st ON st.subscription_id = s.id
      JOIN tracker_mirrors tm ON tm.tracker_key = st.tracker_key AND tm.enabled = 1
      LEFT JOIN user_tracker_mirrors utm ON utm.user_id = s.user_id AND utm.tracker_key = st.tracker_key
      LEFT JOIN subscription_tracker_state sts
        ON sts.subscription_id = s.id AND sts.tracker_key = st.tracker_key
      WHERE s.type = 'rule' AND s.enabled = 1
      ORDER BY s.user_id, st.tracker_key
    `).all() as RuleRow[];

    const groups = new Map<string, RuleRow[]>();
    for (const row of rows) {
      const key = `${row.user_id}:${row.tracker_key}:${row.base_url}`;
      groups.set(key, [...(groups.get(key) || []), row]);
    }

    const newByRule = new Map<string, Release[]>();
    for (const groupRows of groups.values()) {
      const startedMs = Date.now();
      const sample = groupRows[0];
      const plugin = trackerRegistry.get(sample.tracker_key);
      if (!plugin?.rules) {
        const error = new TrackerError("unsupported", `${sample.tracker_key} does not support rule subscriptions`, { trackerKey: sample.tracker_key });
        status.errors += 1;
        for (const row of groupRows) this.updateTrackerState(row.id, row.tracker_key, false, error.message);
        this.recordObservation({
          runId,
          userId: sample.user_id,
          trackerKey: sample.tracker_key,
          operation: "rule-discovery",
          outcome: "unsupported",
          requestedUrl: sample.base_url,
          durationMs: Date.now() - startedMs,
          error,
          details: { subscriptionCount: groupRows.length },
        });
        continue;
      }
      let releases: Release[];
      try {
        releases = (await plugin.rules.discover(this.context(sample.user_id, sample.tracker_key, sample.base_url))).releases;
        status.checked += 1;
      } catch (error) {
        status.errors += 1;
        const message = errorMessage(error);
        for (const row of groupRows) this.updateTrackerState(row.id, row.tracker_key, false, message);
        this.recordObservation({
          runId,
          userId: sample.user_id,
          trackerKey: sample.tracker_key,
          operation: "rule-discovery",
          outcome: diagnosticOutcome(error),
          requestedUrl: sample.base_url,
          durationMs: Date.now() - startedMs,
          error,
          details: { subscriptionCount: groupRows.length },
        });
        continue;
      }

      let matchedCount = 0;
      let newMatchCount = 0;
      for (const row of groupRows) {
        const required = parseTerms(row.required_terms);
        const ignored = parseTerms(row.ignored_terms);
        const matches = releases.filter((release) => titleMatches(release.title, required, ignored));
        matchedCount += matches.length;
        const isBaseline = !row.tracker_initialized;
        for (const release of matches) {
          const matchId = nanoid();
          const result = this.db.prepare(`
            INSERT OR IGNORE INTO rule_matches
              (id, subscription_id, tracker_key, external_id, title, url, magnet, torrent_url, discovered_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            matchId, row.id, release.trackerKey, release.externalId, release.title, release.url,
            release.magnet || null, release.torrentUrl || null, nowIso(),
          );
          if (!isBaseline && result.changes > 0) {
            newMatchCount += 1;
            const enriched = await this.enrichRuleMatch(release, row, plugin, runId);
            this.db.prepare(`
              UPDATE rule_matches SET title = ?, url = ?, magnet = ?, torrent_url = ? WHERE id = ?
            `).run(enriched.title, enriched.url, enriched.magnet || null, enriched.torrentUrl || null, matchId);
            newByRule.set(row.id, [...(newByRule.get(row.id) || []), enriched]);
          }
        }
        this.updateTrackerState(row.id, row.tracker_key, true, null);
        this.db.prepare(`
          UPDATE subscriptions SET initialized = 1, last_checked_at = ?, last_error = NULL, updated_at = ? WHERE id = ?
        `).run(nowIso(), nowIso(), row.id);
      }
      this.recordObservation({
        runId,
        userId: sample.user_id,
        trackerKey: sample.tracker_key,
        operation: "rule-discovery",
        outcome: newMatchCount > 0 ? "new-matches" : "unchanged",
        requestedUrl: sample.base_url,
        releaseCount: releases.length,
        durationMs: Date.now() - startedMs,
        details: { subscriptionCount: groupRows.length, matchedCount, newMatchCount },
      });
    }

    for (const subscriptionId of new Set(rows.map((row) => row.id))) {
      const trackerStates = this.db.prepare(`
        SELECT tracker_key, last_error, last_checked_at
        FROM subscription_tracker_state WHERE subscription_id = ?
      `).all(subscriptionId) as Array<{ tracker_key: TrackerKey; last_error: string | null; last_checked_at: string | null }>;
      const errors = trackerStates
        .filter((state) => state.last_error)
        .map((state) => `${state.tracker_key}: ${state.last_error}`);
      const lastCheckedAt = trackerStates.map((state) => state.last_checked_at).filter(Boolean).sort().at(-1) || nowIso();
      this.db.prepare(`
        UPDATE subscriptions SET last_error = ?, last_checked_at = ?, updated_at = ? WHERE id = ?
      `).run(errors.length ? errors.join("; ").slice(0, 500) : null, lastCheckedAt, nowIso(), subscriptionId);
    }

    for (const [subscriptionId, releases] of newByRule) {
      const rule = rows.find((row) => row.id === subscriptionId);
      if (!rule) continue;
      const timestamp = nowIso();
      const summary = releases.length === 1 ? `New match: ${releases[0].title}` : `${releases.length} new matches`;
      this.db.transaction(() => {
        this.db.prepare(`
          INSERT INTO subscription_events
            (id, subscription_id, user_id, kind, summary, payload, created_at)
          VALUES (?, ?, ?, 'rule-match', ?, ?, ?)
        `).run(nanoid(), subscriptionId, rule.user_id, summary, JSON.stringify({ releases }), timestamp);
        this.db.prepare(`
          UPDATE subscriptions
          SET last_changed_at = ?, is_updated = 1, updated_at = ? WHERE id = ?
        `).run(timestamp, timestamp, subscriptionId);
      })();
      status.changed += 1;
      for (const release of releases) {
        const trackerName = trackerRegistry.get(release.trackerKey)?.manifest.displayName || release.trackerKey;
        await this.telegram.notifyRelease(rule.user_id, {
          release,
          trackerName,
          ruleTerms: parseTerms(rule.required_terms),
        });
      }
    }
  }

  private async enrichRuleMatch(
    release: Release,
    row: RuleRow,
    plugin: NonNullable<ReturnType<typeof trackerRegistry.get>>,
    runId: string,
  ): Promise<Release> {
    if (!plugin.direct || !this.telegram.canNotify(row.user_id)) return release;
    const startedMs = Date.now();
    try {
      const snapshot = await plugin.direct.fetchSnapshot(release.url, this.context(row.user_id, row.tracker_key, row.base_url));
      this.recordObservation({
        runId,
        subscriptionId: row.id,
        userId: row.user_id,
        trackerKey: row.tracker_key,
        operation: "rule-enrichment",
        outcome: "enriched",
        requestedUrl: release.url,
        snapshot,
        durationMs: Date.now() - startedMs,
      });
      return snapshot;
    } catch (error) {
      this.recordObservation({
        runId,
        subscriptionId: row.id,
        userId: row.user_id,
        trackerKey: row.tracker_key,
        operation: "rule-enrichment",
        outcome: diagnosticOutcome(error),
        requestedUrl: release.url,
        snapshot: release,
        durationMs: Date.now() - startedMs,
        error,
      });
      console.warn(`Could not enrich ${row.tracker_key} rule match ${release.externalId}:`, errorMessage(error));
      return release;
    }
  }

  private directRows(extraWhere = "") {
    return this.db.prepare(`
      SELECT s.id, s.user_id, s.name, s.direct_url, s.initialized,
             s.current_fingerprint, s.current_snapshot, st.tracker_key,
             COALESCE(utm.base_url, tm.base_url) AS base_url
      FROM subscriptions s
      JOIN subscription_trackers st ON st.subscription_id = s.id
      JOIN tracker_mirrors tm ON tm.tracker_key = st.tracker_key AND tm.enabled = 1
      LEFT JOIN user_tracker_mirrors utm ON utm.user_id = s.user_id AND utm.tracker_key = st.tracker_key
      WHERE s.type = 'direct' AND s.enabled = 1 ${extraWhere}
      ORDER BY s.created_at
    `);
  }

  private updateTrackerState(subscriptionId: string, trackerKey: TrackerKey, initialized: boolean, error: string | null): void {
    const timestamp = nowIso();
    this.db.prepare(`
      INSERT INTO subscription_tracker_state
        (subscription_id, tracker_key, initialized, last_checked_at, last_error)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(subscription_id, tracker_key) DO UPDATE SET
        initialized = CASE WHEN excluded.initialized = 1 THEN 1 ELSE subscription_tracker_state.initialized END,
        last_checked_at = excluded.last_checked_at,
        last_error = excluded.last_error
    `).run(subscriptionId, trackerKey, initialized ? 1 : 0, timestamp, error);
  }

  private context(userId: string, trackerKey: TrackerKey, baseUrl: string): TrackerContext {
    const credentials = readTrackerCredentials(this.db, this.vault, userId, trackerKey);
    return { userId, baseUrl, username: credentials?.username, password: credentials?.password };
  }

  private recordObservation(input: TrackerObservationInput): void {
    try {
      recordTrackerObservation(this.db, input);
    } catch (error) {
      console.error("Could not persist tracker diagnostic observation:", errorMessage(error));
    }
  }

  private pruneDiagnostics(): void {
    try {
      pruneDiagnostics(this.db);
    } catch (error) {
      console.error("Could not prune tracker diagnostics:", errorMessage(error));
    }
  }

  private scheduleInterval(): void {
    if (this.interval) clearInterval(this.interval);
    const intervalMs = this.pollIntervalMinutes() * 60_000;
    this.nextScheduledAt = new Date(Date.now() + intervalMs).toISOString();
    this.interval = setInterval(() => {
      this.nextScheduledAt = new Date(Date.now() + intervalMs).toISOString();
      void this.run("schedule");
    }, intervalMs);
    this.writeStatus({ ...this.status(), nextRunAt: this.nextScheduledAt });
  }

  private writeStatus(status: SchedulerStatus): void {
    this.db.prepare(`
      INSERT INTO app_state (key, value, updated_at) VALUES ('scheduler_status', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(JSON.stringify(status), nowIso());
  }
}

export function directSnapshotIsTemporarilyUnavailable(snapshot: DirectSnapshot): boolean {
  return snapshot.metadata?.feedSeen === false;
}

export function previousDirectSnapshotWasTemporaryUnavailable(value: string | null): boolean {
  const previous = safeJson(value);
  return isRecord(previous.metadata) && previous.metadata.feedSeen === false;
}

export function previousDirectSnapshotLacksCoverObservation(value: string | null): boolean {
  const previous = safeJson(value);
  return !isRecord(previous.metadata) || previous.metadata.coverObserved !== true;
}

export function directSnapshotRequiresSilentSchemaUpgrade(value: string | null, current: DirectSnapshot): boolean {
  const previous = safeJson(value);
  const previousVersion = isRecord(previous.metadata) ? previous.metadata.snapshotVersion : undefined;
  const currentVersion = current.metadata?.snapshotVersion;
  return typeof currentVersion === "number" && previousVersion !== currentVersion;
}

function parseTerms(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export function titleMatches(title: string, required: string[], ignored: string[]): boolean {
  const normalized = title.toLocaleLowerCase("ru-RU");
  return required.every((term) => normalized.includes(term.toLocaleLowerCase("ru-RU")))
    && !ignored.some((term) => normalized.includes(term.toLocaleLowerCase("ru-RU")));
}

function safeJson(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeChanges(previous: Record<string, unknown>, current: Record<string, unknown>): string[] {
  const changes: string[] = [];
  if (previous.title !== current.title) changes.push("title changed");
  if (previous.coverUrl !== current.coverUrl) changes.push("cover changed");
  if (previous.magnet !== current.magnet) changes.push("magnet changed");
  if (previous.torrentUrl !== current.torrentUrl) changes.push("torrent file changed");
  if (JSON.stringify(previous.metadata || null) !== JSON.stringify(current.metadata || null)) changes.push("metadata changed");
  return changes.length > 0 ? changes : ["release data changed"];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
}

function diagnosticOutcome(error: unknown): string {
  return error instanceof TrackerError ? error.code : "error";
}
