import { nanoid } from "nanoid";
import type { SqliteDatabase } from "./db.js";
import { nowIso } from "./db.js";
import { config } from "./config.js";
import type { DirectSnapshot, Release, TrackerKey } from "./types.js";
import { trackerRegistry } from "./trackers/index.js";
import type { TrackerContext, TrackerPlugin } from "./trackers/core/contracts.js";
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
import { directBaselineOutcome, directSnapshotIsTemporarilyUnavailable, storedDirectSnapshotIsSettled } from "./direct-snapshot.js";
import { feedShowsNoChange } from "./feed-assist.js";
import { enqueueNotification, NotificationQueue } from "./notification-queue.js";
import {
  bufferReleases,
  feedHealth,
  ingestRollingFeedBatch,
  markFeedRecovery,
  ReleaseBufferView,
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
  detail_verified_at: string | null;
  last_error: string | null;
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
  gap_recovered_at: string | null;
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

interface RuleScope {
  subscriptionId: string;
  userId: string;
}

/** State one poll shares between its tracker lanes. Every key includes the tracker. */
interface RunState {
  runId: string;
  status: SchedulerStatus;
  scope?: RuleScope;
  newByRule: Map<string, Release[]>;
  // Keep authenticated detail responses scoped to this run, user, and mirror.
  enrichedReleases: Map<string, DirectSnapshot>;
}

/** The feed a lane read for its rules: the result shared by every rule group, or why it failed. */
type FeedPoll =
  | { ok: true; rollingFeed: RollingFeedResult; requestedUrl: string; releaseCount: number; view: ReleaseBufferView }
  | { ok: false; error: unknown };

type RowSource = Pick<RuleRow, "user_id" | "tracker_key" | "base_url">;

interface TrackerLane {
  trackerKey: TrackerKey;
  directRows: DirectRow[];
  ruleRows: RuleRow[];
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
      await this.pollTrackers(status, runId, scope);
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
        // A requested check always loads the page, so it does not settle for a feed skip either.
        if (outcome === "superseded" || outcome === "feed-unchanged") await this.checkSubscription(subscriptionId, userId);
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

  /**
   * Each tracker is checked in its own lane and the lanes run side by side, so a slow tracker only
   * delays its own subscriptions. Inside a lane requests stay one at a time, as trackers expect.
   */
  private async pollTrackers(status: SchedulerStatus, runId: string, scope?: RuleScope): Promise<void> {
    const directRows = scope ? [] : this.directRows();
    const ruleRows = this.ruleRows(scope);
    const lanes = new Map<TrackerKey, TrackerLane>();
    const laneFor = (trackerKey: TrackerKey) => {
      let lane = lanes.get(trackerKey);
      if (!lane) {
        lane = { trackerKey, directRows: [], ruleRows: [] };
        lanes.set(trackerKey, lane);
      }
      return lane;
    };
    for (const row of directRows) laneFor(row.tracker_key).directRows.push(row);
    for (const row of ruleRows) laneFor(row.tracker_key).ruleRows.push(row);

    const run: RunState = { runId, status, scope, newByRule: new Map(), enrichedReleases: new Map() };
    const results = await Promise.allSettled([...lanes.values()].map((lane) => this.pollTrackerLane(lane, run)));
    // An unexpected failure in one lane must not keep the other trackers from finishing.
    results.forEach((result, index) => {
      if (result.status === "fulfilled") return;
      status.errors += 1;
      console.error(`Could not finish checking ${[...lanes.keys()][index]}:`, errorMessage(result.reason));
    });
    this.settleRuleSubscriptions(ruleRows, run);
  }

  private async pollTrackerLane(lane: TrackerLane, run: RunState): Promise<void> {
    const plugin = trackerRegistry.get(lane.trackerKey);
    const capabilities = plugin?.manifest.capabilities;
    const sample = lane.ruleRows[0] ?? (capabilities?.feedAssistedDirect ? lane.directRows[0] : undefined);
    // The feed is read before the direct checks, which may use it to skip pages it shows as unchanged.
    const feed = plugin?.rules && capabilities?.ruleDiscovery === "feed" && sample
      ? await this.pollFeed(plugin, sample, run.runId)
      : undefined;
    for (const row of lane.directRows) await this.checkDirect(row, run.status, run.runId, feed);
    if (lane.ruleRows.length > 0) await this.pollRules(lane.trackerKey, lane.ruleRows, run, feed);
    // With no rule on this tracker, nothing is missing from a gap, so a full poll closes it.
    else if (feed?.ok && feed.rollingFeed.unresolvedGapSince && !run.scope) markFeedRecovery(this.db, lane.trackerKey, true);
  }

  private checkDirect(row: DirectRow, status: SchedulerStatus, runId: string, feed?: FeedPoll): Promise<string> {
    const active = this.directChecks.get(row.id);
    if (active) return active;
    const work = Promise.resolve().then(async () => {
      // Rows selected before earlier network requests may have been edited or
      // removed. Never compare a fresh snapshot against a stale baseline.
      const current = this.directRow(row.id, row.user_id);
      return current ? this.checkDirectOnce(current, status, runId, feed) : "removed";
    }).finally(() => {
      this.directChecks.delete(row.id);
    });
    this.directChecks.set(row.id, work);
    return work;
  }

  private async checkDirectOnce(row: DirectRow, status: SchedulerStatus, runId: string, feed?: FeedPoll): Promise<string> {
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
    const stored = feed?.ok && plugin.manifest.capabilities.feedAssistedDirect
      ? this.unchangedInFeed(row, plugin, feed)
      : undefined;
    if (stored) {
      const skippedAt = nowIso();
      status.checked += 1;
      this.db.prepare("UPDATE subscriptions SET last_checked_at = ?, updated_at = ? WHERE id = ?").run(skippedAt, skippedAt, row.id);
      this.recordObservation({
        runId,
        subscriptionId: row.id,
        userId: row.user_id,
        trackerKey: row.tracker_key,
        operation: "direct",
        outcome: "feed-unchanged",
        requestedUrl: row.direct_url,
        snapshot: stored,
        durationMs: Date.now() - startedMs,
        details: {
          detailVerifiedAt: row.detail_verified_at,
          feedContinuousSince: feed?.ok ? feed.rollingFeed.continuousSince || null : null,
        },
      });
      return "feed-unchanged";
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
            SET name = ?, initialized = 1, current_fingerprint = ?, current_snapshot = ?, detail_verified_at = ?,
                last_checked_at = ?, last_error = NULL, updated_at = ?
            WHERE id = ?
          `).run(snapshot.title, snapshot.fingerprint, JSON.stringify(snapshot), checkedAt, checkedAt, checkedAt, row.id);
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
            SET name = ?, current_fingerprint = ?, current_snapshot = ?, detail_verified_at = ?, last_checked_at = ?,
                last_changed_at = ?, last_error = NULL, updated_at = ?
            WHERE id = ?
          `).run(currentSnapshot.title, currentSnapshot.fingerprint, JSON.stringify(currentSnapshot), checkedAt, checkedAt, checkedAt, checkedAt, row.id);
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
        // The fingerprint ignores the mirror, so keep the stored links on the one requests now use.
        this.db.prepare(`
          UPDATE subscriptions SET name = ?, current_snapshot = ?, detail_verified_at = ?, last_checked_at = ?, last_error = NULL, updated_at = ?
          WHERE id = ?
        `).run(snapshot.title, JSON.stringify(snapshot), checkedAt, checkedAt, checkedAt, row.id);
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

  private ruleRows(scope?: RuleScope): RuleRow[] {
    return (this.db.prepare(`
      SELECT s.id, s.user_id, s.name, st.tracker_key, s.required_terms, s.ignored_terms,
             utm.base_url AS personal_base_url, tm.base_url AS global_base_url,
             COALESCE(sts.initialized, 0) AS tracker_initialized,
             sts.discovery_revision, sts.gap_recovered_at
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
  }

  /**
   * Reads a feed tracker's feed once for the whole lane. Every rule group uses this one result, and a
   * failed fetch is reported to each group instead of being requested again by every one of them.
   */
  private async pollFeed(plugin: TrackerPlugin, sample: RowSource, runId: string): Promise<FeedPoll> {
    const startedMs = Date.now();
    try {
      if (!plugin.rules) throw new TrackerError("unsupported", `${plugin.manifest.displayName} has no feed`, { trackerKey: sample.tracker_key });
      const batch = await plugin.rules.discover(this.context(sample.user_id, sample.tracker_key, sample.base_url));
      const rollingFeed = ingestRollingFeedBatch(this.db, sample.tracker_key, batch);
      const requestedUrl = batch.sourceUrl || sample.base_url;
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
        requestedUrl,
        releaseCount: batch.releases.length,
        durationMs: Date.now() - startedMs,
        details: {
          feedEntryCount: rollingFeed.entryCount,
          feedNewEntryCount: rollingFeed.newEntryCount,
          feedOverlapCount: rollingFeed.overlapCount ?? null,
          feedBufferedCount: rollingFeed.bufferedCount,
          feedCoverageMinutes: rollingFeed.coverageMinutes ?? null,
          feedCoverageStatus: rollingFeed.coverageStatus,
          feedOldestEntryAt: rollingFeed.oldestEntryAt || null,
          feedNewestEntryAt: rollingFeed.newestEntryAt || null,
          feedContinuousSince: rollingFeed.continuousSince || null,
        },
      });
      return {
        ok: true,
        rollingFeed,
        requestedUrl,
        releaseCount: batch.releases.length,
        view: new ReleaseBufferView(this.db, sample.tracker_key, (release, baseUrl) => releaseOnMirror(release, plugin, baseUrl)),
      };
    } catch (error) {
      this.recordObservation({
        runId,
        userId: sample.user_id,
        trackerKey: sample.tracker_key,
        operation: "feed-poll",
        outcome: diagnosticOutcome(error),
        requestedUrl: error instanceof TrackerError && error.url ? error.url : sample.base_url,
        durationMs: Date.now() - startedMs,
        error,
      });
      return { ok: false, error };
    }
  }

  private async pollRules(trackerKey: TrackerKey, rows: RuleRow[], run: RunState, feed?: FeedPoll): Promise<void> {
    const { runId, status, scope, newByRule, enrichedReleases } = run;
    const groups = new Map<string, RuleRow[]>();
    for (const row of rows) {
      const key = `${row.user_id}:${row.base_url}`;
      const group = groups.get(key);
      if (group) group.push(row);
      else groups.set(key, [row]);
    }

    const rollingFeed = feed?.ok ? feed.rollingFeed : undefined;
    // Catch-up searches during a feed coverage gap: how many ran, and how many failed in a way a retry could fix.
    let recoveryAttempts = 0;
    let recoveryRetries = 0;
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
          let releases: Release[];
          let normalizedTitles: string[] | undefined;
          let requestedUrl: string;
          let releaseCount: number;
          let recoveryCount = 0;
          let recoveryComplete: boolean | undefined;
          let recoverySkipped = false;
          let recoveryError: unknown;
          if (feed) {
            if (!feed.ok) throw feed.error;
            successfulDiscoveries += 1;
            const gapSince = feed.rollingFeed.unresolvedGapSince;
            if (gapSince) {
              const recoveryStartedAt = nowIso();
              // A rule that caught up after the latest gap, or one on its silent baseline, has nothing to recover.
              const caughtUpAfter = feed.rollingFeed.lastGapAt || gapSince;
              const pending = discoveryGroup.rows.filter((row) => (
                !ruleIsBaseline(row, plugin) && !(row.gap_recovered_at && row.gap_recovered_at >= caughtUpAfter)
              ));
              if (pending.length === 0) {
                recoveryComplete = true;
                recoverySkipped = true;
              } else {
                recoveryAttempts += 1;
                // Set when the same search would fail the same way next time, so the gap need not wait for it.
                let recoveryFinal = false;
                try {
                  if (!query || !plugin.rules.recover) {
                    throw new TrackerError("unsupported", `${plugin.manifest.displayName} cannot recover this feed coverage gap`, {
                      trackerKey: sample.tracker_key,
                    });
                  }
                  const recovered = await plugin.rules.recover(
                    this.context(sample.user_id, sample.tracker_key, sample.base_url),
                    query,
                    gapSince,
                  );
                  bufferReleases(this.db, recovered.releases);
                  recoveryCount = recovered.releases.length;
                  recoveryComplete = recovered.coverage.complete;
                  if (!recoveryComplete) {
                    // A retry starts from the same point and reads the same number of pages, so it stops short again.
                    recoveryFinal = true;
                    throw new TrackerError("temporary", `${plugin.manifest.displayName} catch-up search reached its safety limit before the gap was covered`, {
                      trackerKey: sample.tracker_key,
                      retryable: true,
                      url: recovered.sourceUrl,
                    });
                  }
                  this.markGapRecovered(discoveryGroup.rows, recoveryStartedAt);
                } catch (error) {
                  recoveryError = error;
                  recoveryComplete = false;
                  failedDiscoveries += 1;
                  if (!recoveryFinal && !recoveryCannotSucceed(error)) recoveryRetries += 1;
                }
                // Later groups match against what this search found, as they would after reading the buffer.
                if (recoveryCount > 0) feed.view.reload();
              }
              // Rules on their silent baseline accept everything up to now, the gap included.
              this.markGapRecovered(discoveryGroup.rows.filter((row) => ruleIsBaseline(row, plugin)), recoveryStartedAt);
            }
            ({ releases, normalizedTitles } = feed.view.forMirror(sample.base_url));
            requestedUrl = feed.requestedUrl;
            releaseCount = feed.releaseCount;
          } else {
            const batch = await plugin.rules.discover(
              this.context(sample.user_id, sample.tracker_key, sample.base_url),
              query,
            );
            successfulDiscoveries += 1;
            releases = batch.releases;
            requestedUrl = batch.sourceUrl || sample.base_url;
            releaseCount = batch.releases.length;
          }
          const { matchedCount, newMatchCount, baselineCount } = await this.processRuleMatches(
            discoveryGroup.rows,
            releases,
            plugin,
            runId,
            newByRule,
            enrichedReleases,
            normalizedTitles,
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
            requestedUrl,
            releaseCount,
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
                ...(recoverySkipped ? { recoverySkipped } : {}),
              } : {}),
              ...(discoveryGroup.requiredTerms ? { requiredTerms: discoveryGroup.requiredTerms.join(" · ") } : {}),
              ...(plugin.manifest.ruleDiscoveryRevision
                ? { discoveryRevision: plugin.manifest.ruleDiscoveryRevision }
                : {}),
            },
          });
        } catch (error) {
          failedDiscoveries += 1;
          // With the gap still open, this group's catch-up state is unknown, so a later poll must look again.
          if (rollingFeed?.unresolvedGapSince) recoveryRetries += 1;
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

    if (rollingFeed?.unresolvedGapSince) {
      // Only a full poll can attest that every active rule covered the gap. A rule that can never catch
      // up (no login or search, or more results than the search reads) does not keep it open for the rest.
      if (!scope && recoveryRetries === 0) markFeedRecovery(this.db, trackerKey, true);
      else if (recoveryAttempts > 0) markFeedRecovery(this.db, trackerKey, false);
    }
  }

  /** Records that these rules have every release from the gap, so later polls skip their catch-up search. */
  private markGapRecovered(rows: RuleRow[], recoveredAt: string): void {
    const statement = this.db.prepare(`
      INSERT INTO subscription_tracker_state (subscription_id, tracker_key, gap_recovered_at) VALUES (?, ?, ?)
      ON CONFLICT(subscription_id, tracker_key) DO UPDATE SET gap_recovered_at = excluded.gap_recovered_at
    `);
    for (const row of rows) statement.run(row.id, row.tracker_key, recoveredAt);
  }

  /** Sums up each rule's trackers once every lane has finished, since a rule may watch several trackers. */
  private settleRuleSubscriptions(rows: RuleRow[], run: RunState): void {
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
    run.status.changed += run.newByRule.size;
  }

  private async processRuleMatches(
    rows: RuleRow[],
    releases: Release[],
    plugin: TrackerPlugin,
    runId: string,
    newByRule: Map<string, Release[]>,
    enrichedReleases: Map<string, DirectSnapshot>,
    normalizedTitles = releases.map((release) => normalizeTitle(release.title)),
  ): Promise<{ matchedCount: number; newMatchCount: number; baselineCount: number }> {
    let matchedCount = 0;
    let newMatchCount = 0;
    let baselineCount = 0;
    const recordedMatches = this.db.prepare("SELECT external_id FROM rule_matches WHERE subscription_id = ? AND tracker_key = ?");
    const stillCurrent = this.db.prepare(`SELECT 1 FROM subscriptions s JOIN subscription_trackers st ON st.subscription_id = s.id
      WHERE s.id = ? AND s.user_id = ? AND s.enabled = 1 AND s.required_terms = ? AND s.ignored_terms = ? AND st.tracker_key = ?`);
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
      const isBaseline = ruleIsBaseline(row, plugin);
      if (isBaseline) baselineCount += 1;
      // One query per rule instead of one per candidate: a broad rule can match thousands of buffered releases.
      const recorded = new Set((recordedMatches.all(row.id, row.tracker_key) as Array<{ external_id: string }>)
        .map((match) => match.external_id));
      for (const release of matches) {
        if (recorded.has(release.externalId)) continue;
        // Enrich before persistence: a crash during network work must leave the
        // release discoverable, not a recorded match without an outbox entry.
        const enriched = isBaseline ? release : await this.enrichRuleMatch(release, row, plugin, runId, enrichedReleases);
        const current = stillCurrent.get(row.id, row.user_id, row.required_terms, row.ignored_terms, row.tracker_key);
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
        recorded.add(release.externalId);
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

  /**
   * The stored snapshot when the feed shows the topic unchanged since its page was last loaded, so a
   * scheduled check need not load it again. Anything unsettled (a pending baseline, a missing cover,
   * a failed last check) loads the page as before.
   */
  private unchangedInFeed(row: DirectRow, plugin: TrackerPlugin, feed: Extract<FeedPoll, { ok: true }>): DirectSnapshot | undefined {
    if (!row.initialized || !row.current_fingerprint || row.last_error) return undefined;
    if (!storedDirectSnapshotIsSettled(row.current_snapshot, plugin.manifest.snapshotVersion)) return undefined;
    if (this.coverCache && !this.coverCache.has(row.id)) return undefined;
    const stored = safeJson(row.current_snapshot);
    if (typeof stored.externalId !== "string" || typeof stored.title !== "string" || typeof stored.url !== "string") return undefined;
    const unchanged = feedShowsNoChange({
      verifiedAt: row.detail_verified_at,
      storedMagnet: typeof stored.magnet === "string" ? stored.magnet : undefined,
      continuousSince: feed.rollingFeed.continuousSince,
      entry: feed.view.get(stored.externalId),
    });
    return unchanged ? stored as unknown as DirectSnapshot : undefined;
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
             s.current_fingerprint, s.current_snapshot, s.detail_verified_at, s.last_error, st.tracker_key,
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

/** A rule's first evaluation on a tracker, or its first after a discovery change, records matches silently. */
function ruleIsBaseline(row: RuleRow, plugin: TrackerPlugin): boolean {
  const revision = plugin.manifest.ruleDiscoveryRevision;
  return !row.tracker_initialized || Boolean(revision && row.discovery_revision !== revision);
}

/** No login for the catch-up search, or no search at all: retrying cannot help until the user changes something. */
function recoveryCannotSucceed(error: unknown): boolean {
  return error instanceof TrackerError && (error.code === "authentication" || error.code === "unsupported");
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

function releaseOnMirror(release: Release, plugin: TrackerPlugin, baseUrl: string): Release {
  try {
    return { ...release, url: plugin.normalizeUrl(new URL(release.url), baseUrl) };
  } catch {
    return release;
  }
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
