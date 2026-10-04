import { nanoid } from "nanoid";
import type { SqliteDatabase } from "./db.js";
import { nowIso } from "./db.js";
import { config } from "./config.js";
import type { DirectSnapshot, Release, TrackerKey } from "./types.js";
import { trackerRegistry } from "./trackers/index.js";
import type { DiscoveryBatch, TrackerContext, TrackerPlugin } from "./trackers/core/contracts.js";
import { TrackerError } from "./trackers/core/errors.js";
import type { TelegramService } from "./telegram.js";
import { readTrackerCredentials, type SecretVault } from "./secrets.js";
import { effectiveBaseUrl } from "./mirrors.js";
import {
  DIAGNOSTIC_CLEANUP_INTERVAL_MS,
  finishSchedulerRun,
  pruneDiagnostics,
  recordTrackerObservation,
  startSchedulerRun,
  type TrackerObservationInput,
} from "./diagnostics.js";
import type { CoverCacheStore } from "./cover-cache.js";
import { coverErrorMessage } from "./cover-fetch.js";
import { compileTitleMatcher, normalizeTitle, parseTerms } from "./rule-matching.js";
import { directBaselineOutcome, directSnapshotIsTemporarilyUnavailable } from "./direct-snapshot.js";
import { enqueueNotification, NotificationQueue } from "./notification-queue.js";
import {
  bufferReleases,
  bufferedReleases,
  feedHealth,
  ingestRollingFeedBatch,
  markFeedRecovery,
  type FeedHealth,
  type RollingFeedResult,
} from "./release-buffer.js";

export { titleMatches } from "./rule-matching.js";
export { directSnapshotIsTemporarilyUnavailable, directSnapshotRequiresSilentSchemaUpgrade, previousDirectSnapshotLacksCoverObservation, previousDirectSnapshotWasTemporaryUnavailable } from "./direct-snapshot.js";

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
  discovery_revision: string | null;
}

interface RuleDiscoveryGroup {
  rows: RuleRow[];
  requiredTerms?: string[];
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

interface FeedRecoveryRunState {
  attempted: number;
  failed: number;
}

interface RuleScope {
  subscriptionId: string;
  userId: string;
}

export const MIN_POLL_INTERVAL_MINUTES = 5;
export const MAX_POLL_INTERVAL_MINUTES = 6 * 60;
const POLL_INTERVAL_STATE_KEY = "poll_interval_minutes";

export class Scheduler {
  private running = false;
  private currentRun?: Promise<SchedulerStatus>;
  private readonly directChecks = new Map<string, Promise<string>>();
  private readonly subscriptionTimers = new Set<NodeJS.Timeout>();
  private stopping = false;
  private started = false;
  private interval?: NodeJS.Timeout;
  private startupTimer?: NodeJS.Timeout;
  private diagnosticsCleanupTimer?: NodeJS.Timeout;
  private nextScheduledAt?: string;
  readonly notifications: NotificationQueue;

  constructor(
    private readonly db: SqliteDatabase,
    private readonly telegram: TelegramService,
    private readonly vault: SecretVault,
    private readonly coverCache?: CoverCacheStore,
  ) { this.notifications = new NotificationQueue(db, telegram); }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.stopping = false;
    this.notifications.start();
    this.pruneDiagnostics();
    this.diagnosticsCleanupTimer = setInterval(() => this.pruneDiagnostics(), DIAGNOSTIC_CLEANUP_INTERVAL_MS);
    this.diagnosticsCleanupTimer.unref();
    this.startupTimer = setTimeout(() => void this.run("startup"), config.pollStartupDelaySeconds * 1_000);
    this.scheduleInterval();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.started = false;
    if (this.interval) clearInterval(this.interval);
    if (this.startupTimer) clearTimeout(this.startupTimer);
    if (this.diagnosticsCleanupTimer) clearInterval(this.diagnosticsCleanupTimer);
    this.interval = undefined;
    this.startupTimer = undefined;
    this.diagnosticsCleanupTimer = undefined;
    this.nextScheduledAt = undefined;
    for (const timer of this.subscriptionTimers) clearTimeout(timer);
    this.subscriptionTimers.clear();
    await Promise.allSettled([...(this.currentRun ? [this.currentRun] : []), ...this.directChecks.values()]);
    await this.notifications.stop();
  }

  queueSubscriptionCheck(subscriptionId: string, userId: string): void {
    if (this.stopping) return;
    const timer = setTimeout(() => {
      this.subscriptionTimers.delete(timer);
      void this.checkSubscription(subscriptionId, userId).catch((error) => {
        console.error("Could not check queued subscription:", errorMessage(error));
      });
    }, 50);
    this.subscriptionTimers.add(timer);
    timer.unref();
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

  discoveryHealth(): FeedHealth[] {
    return feedHealth(this.db, this.pollIntervalMinutes());
  }

  run(trigger = "manual"): Promise<SchedulerStatus> {
    return this.runWithScope(trigger);
  }

  private async runWithScope(trigger: string, scope?: RuleScope): Promise<SchedulerStatus> {
    if (this.stopping) return this.status();
    // A targeted check must still run if it was added/edited after an active
    // poll selected its rows. Full-poll callers can share the active run.
    while (this.currentRun) {
      if (!scope) return this.currentRun;
      await this.currentRun;
    }
    if (this.stopping) return this.status();
    this.running = true;
    const work = Promise.resolve().then(() => this.executeRun(trigger, scope)).finally(() => {
      this.running = false;
      this.currentRun = undefined;
    });
    this.currentRun = work;
    return work;
  }

  private async executeRun(trigger: string, scope?: RuleScope): Promise<SchedulerStatus> {
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
      if (!scope) await this.pollDirect(status, runId);
      await this.pollRules(status, runId, scope);
      await this.notifications.drain();
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
    if (this.stopping) return;
    const direct = this.directRow(subscriptionId, userId);
    if (direct) {
      const active = this.directChecks.get(subscriptionId);
      if (active) {
        const outcome = await active;
        // A queued check for an edited topic must not disappear behind the
        // superseded request it joined. Normal overlapping checks still share.
        if (outcome === "superseded") await this.checkSubscription(subscriptionId, userId);
        return;
      }
      const startedMs = Date.now();
      const startedAt = nowIso();
      const runId = startSchedulerRun(this.db, "subscription", startedAt);
      const status: SchedulerStatus = { running: true, checked: 0, changed: 0, errors: 0, trigger: "subscription" };
      try {
        await this.checkDirect(direct, status, runId);
        await this.notifications.drain();
      } finally {
        finishSchedulerRun(this.db, runId, nowIso(), status, Date.now() - startedMs);
      }
      return;
    }
    const type = this.db.prepare("SELECT type FROM subscriptions WHERE id = ? AND user_id = ?")
      .get(subscriptionId, userId) as { type: string } | undefined;
    if (type?.type === "rule") await this.runWithScope("subscription", { subscriptionId, userId });
  }

  private async pollDirect(status: SchedulerStatus, runId: string): Promise<void> {
    const rows = this.directRows();
    for (const row of rows) await this.checkDirect(row, status, runId);
  }

  private checkDirect(row: DirectRow, status: SchedulerStatus, runId: string): Promise<string> {
    const active = this.directChecks.get(row.id);
    if (active) return active;
    const work = Promise.resolve().then(async () => {
      // Rows selected before earlier network requests may have been edited or
      // removed. Never compare a fresh snapshot against a stale baseline.
      const current = this.directRow(row.id, row.user_id);
      return current ? this.checkDirectOnce(current, status, runId) : "removed";
    }).finally(() => {
      this.directChecks.delete(row.id);
    });
    this.directChecks.set(row.id, work);
    return work;
  }

  private async checkDirectOnce(row: DirectRow, status: SchedulerStatus, runId: string): Promise<string> {
    const startedMs = Date.now();
    const plugin = trackerRegistry.get(row.tracker_key);
    let snapshot: DirectSnapshot | undefined;
    let observationError: unknown;
    let outcome = "error";
    let coverRefreshError: string | undefined;
    let coverDetails: Record<string, string | number | boolean | null> | undefined;
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
      return "unsupported";
    }
    const checkedAt = nowIso();
    try {
      snapshot = await plugin.direct.fetchSnapshot(row.direct_url, this.context(row.user_id, row.tracker_key, row.base_url));
      status.checked += 1;
      if (!this.directRowStillCurrent(row)) {
        outcome = "superseded";
        return outcome;
      }
      if (!directSnapshotIsTemporarilyUnavailable(snapshot) && this.coverCache) {
        const isBaseline = !row.initialized || !row.current_fingerprint;
        const snapshotChanged = snapshot.fingerprint !== row.current_fingerprint;
        const needsBackfill = !this.coverCache.has(row.id);
        if (isBaseline || snapshotChanged || needsBackfill) {
          const retainedCache = this.coverCache.has(row.id);
          try {
            const refreshed = await this.coverCache.refresh(row.id, snapshot);
            coverDetails = {
              coverCacheStatus: retainedCache ? "refreshed" : "cached",
              coverCacheBytes: refreshed.byteLength,
              coverCachedAt: refreshed.cachedAt,
              ...(refreshed.retrievalFallbackErrors
                ? { coverCacheFallback: refreshed.retrievalFallbackErrors }
                : {}),
            };
          } catch (error) {
            coverRefreshError = coverErrorMessage(error);
            coverDetails = {
              coverCacheStatus: retainedCache ? "refresh-failed-cache-retained" : "refresh-failed-no-cache",
              coverCacheError: coverRefreshError,
            };
          }
        } else {
          coverDetails = { coverCacheStatus: "current" };
        }
      }
      // Cover retrieval also awaits network work; edits during that request
      // must not allow this old snapshot (or its newly cached artwork) back in.
      if (this.coverCache && !this.directRowStillCurrent(row)) {
        outcome = "superseded";
        if (coverDetails?.coverCacheStatus === "cached" || coverDetails?.coverCacheStatus === "refreshed") {
          await this.coverCache.remove(row.id);
        }
        return outcome;
      }
      const baselineOutcome = directBaselineOutcome(row.initialized, row.current_fingerprint, row.current_snapshot, snapshot);
      if (baselineOutcome) {
        outcome = baselineOutcome;
        if (baselineOutcome === "temporarily-unavailable") {
          this.db.prepare(`
            UPDATE subscriptions SET last_checked_at = ?, last_error = NULL, updated_at = ? WHERE id = ?
          `).run(checkedAt, checkedAt, row.id);
        } else {
          this.db.prepare(`
            UPDATE subscriptions
            SET name = ?, initialized = 1, current_fingerprint = ?, current_snapshot = ?,
                last_checked_at = ?, last_error = NULL, updated_at = ?
            WHERE id = ?
          `).run(snapshot.title, snapshot.fingerprint, JSON.stringify(snapshot), checkedAt, checkedAt, row.id);
        }
        return outcome;
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
                last_changed_at = ?, last_error = NULL, updated_at = ?
            WHERE id = ?
          `).run(currentSnapshot.title, currentSnapshot.fingerprint, JSON.stringify(currentSnapshot), checkedAt, checkedAt, checkedAt, row.id);
          this.db.prepare(`
            INSERT INTO subscription_events
              (id, subscription_id, user_id, kind, summary, payload, created_at)
            VALUES (?, ?, ?, 'direct-change', ?, ?, ?)
          `).run(eventId, row.id, row.user_id, changes.join(", "), JSON.stringify({ previous, current: currentSnapshot, changes }), checkedAt);
          enqueueNotification(this.db, row.user_id, `direct:${eventId}`, {
            subscriptionId: row.id, release: currentSnapshot,
            trackerName: plugin.manifest.displayName, changes, coverRefreshError,
          });
        })();
        status.changed += 1;
      } else {
        outcome = "unchanged";
        this.db.prepare(`
          UPDATE subscriptions SET name = ?, last_checked_at = ?, last_error = NULL, updated_at = ? WHERE id = ?
        `).run(snapshot.title, checkedAt, checkedAt, row.id);
      }
    } catch (error) {
      observationError = error;
      if (!this.directRowStillCurrent(row)) {
        outcome = "superseded";
        return outcome;
      }
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
        details: coverDetails,
      });
    }
    return outcome;
  }

  private async pollRules(status: SchedulerStatus, runId: string, scope?: RuleScope): Promise<void> {
    const rows: RuleRow[] = (this.db.prepare(`
      SELECT s.id, s.user_id, s.name, st.tracker_key, s.required_terms, s.ignored_terms,
             utm.base_url AS personal_base_url, tm.base_url AS global_base_url,
             COALESCE(sts.initialized, 0) AS tracker_initialized,
             sts.discovery_revision
      FROM subscriptions s
      JOIN users u ON u.id = s.user_id AND u.disabled = 0
      JOIN subscription_trackers st ON st.subscription_id = s.id
      JOIN tracker_mirrors tm ON tm.tracker_key = st.tracker_key AND tm.enabled = 1
      LEFT JOIN user_tracker_mirrors utm ON utm.user_id = s.user_id AND utm.tracker_key = st.tracker_key
      LEFT JOIN subscription_tracker_state sts
        ON sts.subscription_id = s.id AND sts.tracker_key = st.tracker_key
      WHERE s.type = 'rule' AND s.enabled = 1
      ${scope ? "AND s.id = ? AND s.user_id = ?" : ""}
      ORDER BY s.user_id, st.tracker_key
    `).all(...(scope ? [scope.subscriptionId, scope.userId] : [])) as Array<Omit<RuleRow, "base_url"> & MirrorColumns>).map(withBaseUrl);

    const groups = new Map<string, RuleRow[]>();
    for (const row of rows) {
      const key = `${row.user_id}:${row.tracker_key}:${row.base_url}`;
      const group = groups.get(key);
      if (group) group.push(row);
      else groups.set(key, [row]);
    }

    const rulesById = new Map(rows.map((row) => [row.id, row]));
    const newByRule = new Map<string, Release[]>();
    // Keep authenticated detail responses scoped to this run, user, and mirror.
    const enrichedReleases = new Map<string, DirectSnapshot>();
    const feedDiscoveryBatches = new Map<TrackerKey, DiscoveryBatch>();
    const rollingFeeds = new Map<TrackerKey, RollingFeedResult>();
    const recoveryRuns = new Map<TrackerKey, FeedRecoveryRunState>();
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
      let successfulDiscoveries = 0;
      let failedDiscoveries = 0;
      for (const discoveryGroup of ruleDiscoveryGroups(plugin, groupRows)) {
        const discoveryStartedMs = Date.now();
        const query = discoveryGroup.requiredTerms
          ? { requiredTerms: discoveryGroup.requiredTerms }
          : undefined;
        try {
          const cachedFeedBatch = plugin.manifest.capabilities.ruleDiscovery === "feed"
            ? feedDiscoveryBatches.get(sample.tracker_key)
            : undefined;
          const batch = cachedFeedBatch
            ? discoveryBatchForBaseUrl(cachedFeedBatch, plugin, sample.base_url)
            : await plugin.rules.discover(
              this.context(sample.user_id, sample.tracker_key, sample.base_url),
              query,
            );
          if (!cachedFeedBatch && plugin.manifest.capabilities.ruleDiscovery === "feed") {
            feedDiscoveryBatches.set(sample.tracker_key, batch);
          }
          successfulDiscoveries += 1;
          let releases = batch.releases;
          let rollingFeed: RollingFeedResult | undefined;
          let recoveryCount = 0;
          let recoveryComplete: boolean | undefined;
          let recoveryError: unknown;
          if (batch.coverage.source === "feed") {
            rollingFeed = rollingFeeds.get(sample.tracker_key);
            if (!rollingFeed) {
              rollingFeed = ingestRollingFeedBatch(this.db, sample.tracker_key, batch);
              rollingFeeds.set(sample.tracker_key, rollingFeed);
              this.recordObservation({
                runId,
                userId: sample.user_id,
                trackerKey: sample.tracker_key,
                operation: "feed-poll",
                outcome: rollingFeed.gapDetected
                  ? "coverage-gap"
                  : rollingFeed.coverageStatus === "baseline"
                    ? "baseline"
                    : "continuous",
                requestedUrl: batch.sourceUrl || sample.base_url,
                releaseCount: batch.releases.length,
                durationMs: Date.now() - discoveryStartedMs,
                details: {
                  feedEntryCount: rollingFeed.entryCount,
                  feedNewEntryCount: rollingFeed.newEntryCount,
                  feedOverlapCount: rollingFeed.overlapCount ?? null,
                  feedBufferedCount: rollingFeed.bufferedCount,
                  feedCoverageMinutes: rollingFeed.coverageMinutes ?? null,
                  feedCoverageStatus: rollingFeed.coverageStatus,
                  feedOldestEntryAt: rollingFeed.oldestEntryAt || null,
                  feedNewestEntryAt: rollingFeed.newestEntryAt || null,
                },
              });
            }
            if (rollingFeed.unresolvedGapSince) {
              const recoveryRun = recoveryRuns.get(sample.tracker_key) || { attempted: 0, failed: 0 };
              recoveryRun.attempted += 1;
              recoveryRuns.set(sample.tracker_key, recoveryRun);
              try {
                if (!query || !plugin.rules.recover) {
                  throw new TrackerError("unsupported", `${plugin.manifest.displayName} cannot recover this feed coverage gap`, {
                    trackerKey: sample.tracker_key,
                  });
                }
                const recovered = await plugin.rules.recover(
                  this.context(sample.user_id, sample.tracker_key, sample.base_url),
                  query,
                  rollingFeed.unresolvedGapSince,
                );
                bufferReleases(this.db, recovered.releases);
                recoveryCount = recovered.releases.length;
                recoveryComplete = recovered.coverage.complete;
                if (!recoveryComplete) {
                  throw new TrackerError("temporary", `${plugin.manifest.displayName} catch-up search reached its safety limit before the gap was covered`, {
                    trackerKey: sample.tracker_key,
                    retryable: true,
                    url: recovered.sourceUrl,
                  });
                }
              } catch (error) {
                recoveryError = error;
                recoveryComplete = false;
                recoveryRun.failed += 1;
                failedDiscoveries += 1;
              }
            }
            releases = releasesForBaseUrl(bufferedReleases(this.db, sample.tracker_key), plugin, sample.base_url);
          }
          const { matchedCount, newMatchCount, baselineCount } = await this.processRuleMatches(
            discoveryGroup.rows,
            releases,
            plugin,
            runId,
            newByRule,
            enrichedReleases,
          );
          if (recoveryError) {
            const message = errorMessage(recoveryError);
            for (const row of discoveryGroup.rows) this.updateTrackerState(row.id, row.tracker_key, false, message);
          }
          const coverageRecovered = Boolean(rollingFeed?.unresolvedGapSince && recoveryComplete);
          const coverageGap = Boolean(rollingFeed?.unresolvedGapSince && !recoveryComplete);
          this.recordObservation({
            runId,
            userId: sample.user_id,
            trackerKey: sample.tracker_key,
            operation: "rule-discovery",
            outcome: coverageGap
              ? "coverage-gap"
              : newMatchCount > 0
                ? "new-matches"
                : coverageRecovered
                  ? "recovered"
                  : baselineCount > 0
                    ? "baseline"
                    : "unchanged",
            requestedUrl: batch.sourceUrl || sample.base_url,
            releaseCount: batch.releases.length,
            durationMs: Date.now() - discoveryStartedMs,
            error: recoveryError,
            details: {
              subscriptionCount: discoveryGroup.rows.length,
              matchedCount,
              newMatchCount,
              baselineCount,
              ...(rollingFeed ? {
                recoveryCount,
                recoveryComplete: recoveryComplete ?? null,
              } : {}),
              ...(discoveryGroup.requiredTerms ? { requiredTerms: discoveryGroup.requiredTerms.join(" · ") } : {}),
              ...(plugin.manifest.ruleDiscoveryRevision
                ? { discoveryRevision: plugin.manifest.ruleDiscoveryRevision }
                : {}),
            },
          });
        } catch (error) {
          failedDiscoveries += 1;
          const message = errorMessage(error);
          for (const row of discoveryGroup.rows) this.updateTrackerState(row.id, row.tracker_key, false, message);
          this.recordObservation({
            runId,
            userId: sample.user_id,
            trackerKey: sample.tracker_key,
            operation: "rule-discovery",
            outcome: diagnosticOutcome(error),
            requestedUrl: error instanceof TrackerError && error.url ? error.url : sample.base_url,
            durationMs: Date.now() - discoveryStartedMs,
            error,
            details: {
              subscriptionCount: discoveryGroup.rows.length,
              ...(discoveryGroup.requiredTerms ? { requiredTerms: discoveryGroup.requiredTerms.join(" · ") } : {}),
            },
          });
        }
      }
      if (successfulDiscoveries > 0) status.checked += 1;
      if (failedDiscoveries > 0) status.errors += 1;
    }

    for (const [trackerKey, recovery] of recoveryRuns) {
      // Only a full poll can attest that every active rule covered the gap.
      if (recovery.attempted > 0) markFeedRecovery(this.db, trackerKey, !scope && recovery.failed === 0);
    }

    for (const subscriptionId of rulesById.keys()) {
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
      const rule = rulesById.get(subscriptionId);
      if (!rule) continue;
      status.changed += 1;
    }
  }

  private async processRuleMatches(
    rows: RuleRow[],
    releases: Release[],
    plugin: TrackerPlugin,
    runId: string,
    newByRule: Map<string, Release[]>,
    enrichedReleases: Map<string, DirectSnapshot>,
  ): Promise<{ matchedCount: number; newMatchCount: number; baselineCount: number }> {
    let matchedCount = 0;
    let newMatchCount = 0;
    let baselineCount = 0;
    const normalizedTitles = releases.map((release) => normalizeTitle(release.title));
    const insertMatch = this.db.prepare(`
      INSERT OR IGNORE INTO rule_matches
        (id, subscription_id, tracker_key, external_id, title, url, magnet, torrent_url, discovered_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const updateSubscription = this.db.prepare(`
      UPDATE subscriptions SET initialized = 1, last_checked_at = ?, last_error = NULL, updated_at = ? WHERE id = ?
    `);
    for (const row of rows) {
      const matchesTitle = compileTitleMatcher(parseTerms(row.required_terms), parseTerms(row.ignored_terms));
      const matches = releases.filter((_, index) => matchesTitle(normalizedTitles[index]));
      matchedCount += matches.length;
      const discoveryRevision = plugin.manifest.ruleDiscoveryRevision;
      const isBaseline = !row.tracker_initialized
        || Boolean(discoveryRevision && row.discovery_revision !== discoveryRevision);
      if (isBaseline) baselineCount += 1;
      for (const release of matches) {
        if (this.db.prepare("SELECT 1 FROM rule_matches WHERE subscription_id = ? AND tracker_key = ? AND external_id = ?")
          .get(row.id, release.trackerKey, release.externalId)) continue;
        // Enrich before persistence: a crash during network work must leave the
        // release discoverable, not a recorded match without an outbox entry.
        const enriched = isBaseline ? release : await this.enrichRuleMatch(release, row, plugin, runId, enrichedReleases);
        const current = this.db.prepare(`SELECT 1 FROM subscriptions s JOIN subscription_trackers st ON st.subscription_id = s.id
          WHERE s.id = ? AND s.user_id = ? AND s.enabled = 1 AND s.required_terms = ? AND s.ignored_terms = ? AND st.tracker_key = ?`)
          .get(row.id, row.user_id, row.required_terms, row.ignored_terms, row.tracker_key);
        if (!current) continue;
        const matchId = nanoid();
        const result = this.db.transaction(() => {
          const result = insertMatch.run(
            matchId, row.id, release.trackerKey, release.externalId, enriched.title, enriched.url,
            enriched.magnet || null, enriched.torrentUrl || null, nowIso(),
          );
          if (!isBaseline && result.changes > 0) {
            const timestamp = nowIso();
            this.db.prepare(`INSERT INTO subscription_events (id, subscription_id, user_id, kind, summary, payload, created_at)
              VALUES (?, ?, ?, 'rule-match', ?, ?, ?)`)
              .run(nanoid(), row.id, row.user_id, `New match: ${enriched.title}`, JSON.stringify({ releases: [enriched] }), timestamp);
            this.db.prepare("UPDATE subscriptions SET last_changed_at = ?, updated_at = ? WHERE id = ?").run(timestamp, timestamp, row.id);
            enqueueNotification(this.db, row.user_id, `rule:${matchId}`, {
              subscriptionId: row.id, release: enriched,
              trackerName: plugin.manifest.displayName, ruleTerms: parseTerms(row.required_terms),
            });
          }
          return result;
        })();
        if (!isBaseline && result.changes > 0) {
          newMatchCount += 1;
          const newMatches = newByRule.get(row.id);
          if (newMatches) newMatches.push(enriched);
          else newByRule.set(row.id, [enriched]);
        }
      }
      this.updateTrackerState(row.id, row.tracker_key, true, null, discoveryRevision);
      updateSubscription.run(nowIso(), nowIso(), row.id);
    }
    return { matchedCount, newMatchCount, baselineCount };
  }

  private async enrichRuleMatch(
    release: Release,
    row: RuleRow,
    plugin: NonNullable<ReturnType<typeof trackerRegistry.get>>,
    runId: string,
    enrichedReleases: Map<string, DirectSnapshot>,
  ): Promise<Release> {
    if (!plugin.direct || !this.telegram.canNotify(row.user_id)) return release;
    const startedMs = Date.now();
    try {
      const cacheKey = JSON.stringify([row.user_id, row.tracker_key, row.base_url, release.externalId, release.url]);
      const cached = enrichedReleases.get(cacheKey);
      const snapshot = cached
        || await plugin.direct.fetchSnapshot(release.url, this.context(row.user_id, row.tracker_key, row.base_url));
      if (!directSnapshotIsTemporarilyUnavailable(snapshot)) enrichedReleases.set(cacheKey, snapshot);
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
        details: { cacheHit: Boolean(cached) },
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

  private directRowStillCurrent(row: DirectRow): boolean {
    const latest = this.directRow(row.id, row.user_id);
    return Boolean(latest && latest.direct_url === row.direct_url && latest.base_url === row.base_url
      && latest.tracker_key === row.tracker_key && latest.current_fingerprint === row.current_fingerprint
      && latest.initialized === row.initialized);
  }

  private directRow(subscriptionId: string, userId: string): DirectRow | undefined {
    return this.directRows("AND s.id = ? AND s.user_id = ?", subscriptionId, userId)[0];
  }

  private directRows(extraWhere = "", ...parameters: string[]): DirectRow[] {
    return (this.db.prepare(`
      SELECT s.id, s.user_id, s.name, s.direct_url, s.initialized,
             s.current_fingerprint, s.current_snapshot, st.tracker_key,
             utm.base_url AS personal_base_url, tm.base_url AS global_base_url
      FROM subscriptions s
      JOIN users u ON u.id = s.user_id AND u.disabled = 0
      JOIN subscription_trackers st ON st.subscription_id = s.id
      JOIN tracker_mirrors tm ON tm.tracker_key = st.tracker_key AND tm.enabled = 1
      LEFT JOIN user_tracker_mirrors utm ON utm.user_id = s.user_id AND utm.tracker_key = st.tracker_key
      WHERE s.type = 'direct' AND s.enabled = 1 ${extraWhere}
      ORDER BY s.created_at
    `).all(...parameters) as Array<Omit<DirectRow, "base_url"> & MirrorColumns>).map(withBaseUrl);
  }

  private updateTrackerState(
    subscriptionId: string,
    trackerKey: TrackerKey,
    initialized: boolean,
    error: string | null,
    discoveryRevision?: string,
  ): void {
    const timestamp = nowIso();
    this.db.prepare(`
      INSERT INTO subscription_tracker_state
        (subscription_id, tracker_key, initialized, discovery_revision, last_checked_at, last_error)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(subscription_id, tracker_key) DO UPDATE SET
        initialized = CASE WHEN excluded.initialized = 1 THEN 1 ELSE subscription_tracker_state.initialized END,
        discovery_revision = COALESCE(excluded.discovery_revision, subscription_tracker_state.discovery_revision),
        last_checked_at = excluded.last_checked_at,
        last_error = excluded.last_error
    `).run(subscriptionId, trackerKey, initialized ? 1 : 0, discoveryRevision || null, timestamp, error);
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

interface MirrorColumns {
  personal_base_url: string | null;
  global_base_url: string;
}

function withBaseUrl<T extends { tracker_key: TrackerKey } & MirrorColumns>(row: T): Omit<T, keyof MirrorColumns> & { base_url: string } {
  const { personal_base_url: personal, global_base_url: global, ...rest } = row;
  return { ...rest, base_url: effectiveBaseUrl(row.tracker_key, personal, global) };
}

function ruleDiscoveryGroups(plugin: TrackerPlugin, rows: RuleRow[]): RuleDiscoveryGroup[] {
  if (plugin.manifest.capabilities.ruleDiscovery !== "search" && !plugin.rules?.recover) return [{ rows }];
  const groups = new Map<string, RuleDiscoveryGroup>();
  for (const row of rows) {
    const requiredTerms = parseTerms(row.required_terms);
    const key = JSON.stringify(requiredTerms
      .map((term) => term.trim().toLocaleLowerCase("ru-RU"))
      .filter(Boolean)
      .sort());
    const existing = groups.get(key);
    if (existing) existing.rows.push(row);
    else groups.set(key, { rows: [row], requiredTerms });
  }
  return [...groups.values()];
}

function releasesForBaseUrl(releases: Release[], plugin: TrackerPlugin, baseUrl: string): Release[] {
  return releases.map((release) => {
    try {
      return { ...release, url: plugin.normalizeUrl(new URL(release.url), baseUrl) };
    } catch {
      return release;
    }
  });
}

function discoveryBatchForBaseUrl(batch: DiscoveryBatch, plugin: TrackerPlugin, baseUrl: string): DiscoveryBatch {
  return { ...batch, releases: releasesForBaseUrl(batch.releases, plugin, baseUrl) };
}

function safeJson(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
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
