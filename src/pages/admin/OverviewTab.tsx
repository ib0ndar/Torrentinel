import type { CSSProperties } from "react";
import { Icon } from "../../components/Icon";
import { formatCoverageMinutes, formatPollInterval, pollingCadence, POLL_INTERVAL_MARKERS, POLL_INTERVAL_OPTIONS, relativeTime, shortPollInterval } from "../../format";
import { translate, useI18n } from "../../i18n";
import type { DiscoveryHealth, SchedulerStatus } from "../../types";

export function OverviewTab({ status, intervalMinutes, intervalIndex, onIntervalIndexChange, discoveryHealth, polling, savingInterval, onPoll, onApplyInterval }: {
  status: SchedulerStatus | null; intervalMinutes: number; intervalIndex: number; onIntervalIndexChange: (index: number) => void; discoveryHealth: DiscoveryHealth[];
  polling: boolean; savingInterval: boolean; onPoll: () => void; onApplyInterval: () => void;
}) {
  const { t } = useI18n();
  const selectedInterval = POLL_INTERVAL_OPTIONS[intervalIndex], intervalChanged = selectedInterval !== intervalMinutes, intervalProgress = intervalIndex / (POLL_INTERVAL_OPTIONS.length - 1) * 100;
  const rutrackerHealth = discoveryHealth.find((health) => health.trackerKey === "rutracker");
  const selectedSafetyMargin = rutrackerHealth?.coverageMinutes ? Math.round(rutrackerHealth.coverageMinutes / selectedInterval * 10) / 10 : undefined;
  const coverageTone = !rutrackerHealth ? "state--pending" : rutrackerHealth.unresolvedGapSince || (selectedSafetyMargin !== undefined && selectedSafetyMargin < 1.5) ? "state--error" : selectedSafetyMargin !== undefined && selectedSafetyMargin < 2 ? "state--pending" : "state--good";
  return <>
    <section className="admin-strip">
      <div>
        <span className={`status-dot ${status?.running ? "status-dot--live" : ""}`} />
        <span>
          <strong>{status?.running ? t("Poll in progress") : pollingCadence(intervalMinutes)}</strong>
          <small>{status?.lastFinishedAt ? t("Last completed {time}", { time: relativeTime(status.lastFinishedAt) }) : t("No completed poll yet")}</small>
        </span>
      </div>
      <div className="run-metrics">
        <span><strong>{status?.checked || 0}</strong> {t("sources")}</span>
        <span><strong>{status?.changed || 0}</strong> {t("changed")}</span>
        <span><strong>{status?.errors || 0}</strong> {t("errors")}</span>
      </div>
      <button className="button button--quiet" disabled={polling || status?.running} onClick={onPoll}><Icon name="refresh" />{t(polling ? "Polling…" : "Run now")}</button>
    </section>
    <section className="admin-schedule" aria-labelledby="poll-interval-heading">
      <div className="schedule-copy">
        <span className="schedule-icon"><Icon name="clock" /></span>
        <span><strong id="poll-interval-heading">{t("Polling interval")}</strong><small>{t("One schedule for every user and tracker")}</small></span>
      </div>
      <div className="interval-control">
        <div className="interval-readout">
          <strong>{formatPollInterval(selectedInterval)}</strong>
          <small>{intervalChanged ? t("Currently {interval}", { interval: formatPollInterval(intervalMinutes) }) : t("Active schedule")}</small>
        </div>
        <input className="interval-slider" type="range" min={0} max={POLL_INTERVAL_OPTIONS.length - 1} step={1} value={intervalIndex} aria-label={t("Polling interval")} aria-valuetext={formatPollInterval(selectedInterval)}
          style={{ "--interval-progress": `${intervalProgress}%` } as CSSProperties} onChange={(event) => onIntervalIndexChange(Number(event.target.value))} />
        <div className="interval-scale" aria-hidden="true">
          {POLL_INTERVAL_MARKERS.map((minutes, markerIndex) => <span key={minutes} className={markerIndex === 0 ? "scale-first" : markerIndex === POLL_INTERVAL_MARKERS.length - 1 ? "scale-last" : ""}
            style={{ left: `${POLL_INTERVAL_OPTIONS.indexOf(minutes) / (POLL_INTERVAL_OPTIONS.length - 1) * 100}%` }}>{shortPollInterval(minutes)}</span>)}
        </div>
      </div>
      <button className="button button--quiet" disabled={!intervalChanged || savingInterval} onClick={onApplyInterval}>{t(savingInterval ? "Applying…" : "Apply interval")}</button>
    </section>
    <section className="coverage-strip" aria-labelledby="rutracker-coverage-heading">
      <span className="schedule-icon"><Icon name={coverageTone === "state--error" ? "alert" : "monitor"} /></span>
      <span className="coverage-copy"><strong id="rutracker-coverage-heading">{t("RuTracker feed coverage")}</strong><small>{coverageDescription(rutrackerHealth, selectedSafetyMargin)}</small></span>
      {rutrackerHealth ? <div className="coverage-metrics">
        <span><strong>{rutrackerHealth.entryCount}</strong><small>{t("entries")}</small></span>
        <span><strong>{rutrackerHealth.newEntryCount}</strong><small>{t(rutrackerHealth.coverageStatus === "baseline" ? "seeded" : "new")}</small></span>
        <span><strong>{rutrackerHealth.overlapCount ?? "—"}</strong><small>{t("overlap")}</small></span>
        <span><strong>{rutrackerHealth.coverageMinutes !== undefined ? formatCoverageMinutes(rutrackerHealth.coverageMinutes) : "—"}</strong><small>{t("window")}</small></span>
        <span><strong>{selectedSafetyMargin !== undefined ? `${selectedSafetyMargin}×` : "—"}</strong><small>{t("margin")}</small></span>
      </div> : <span className="coverage-empty">{t("Available after the first RuTracker rule poll")}</span>}
      <span className={`state ${coverageTone}`}>{t(rutrackerHealth?.unresolvedGapSince ? "Gap detected" : rutrackerHealth?.coverageStatus === "recovered" ? "Recovered" : rutrackerHealth?.coverageStatus === "baseline" ? "Baseline" : rutrackerHealth ? "Continuous" : "Pending")}</span>
    </section>
  </>;
}

function coverageDescription(health: DiscoveryHealth | undefined, margin: number | undefined): string {
  const t = translate;
  if (!health) return t("The configured polling interval remains the actual tracker request interval.");
  if (health.coverageStatus === "baseline") return t("{count} entries were seeded as the initial sample. Overlap becomes available after the next poll.", { count: health.entryCount });
  if (health.unresolvedGapSince) return t("Continuity was lost {time}. Authenticated catch-up remains incomplete.", { time: relativeTime(health.unresolvedGapSince) });
  if (margin !== undefined && margin < 1.5) return t("The selected interval is too close to the current {window} rolling window.", { window: formatCoverageMinutes(health.coverageMinutes || 0) });
  if (margin !== undefined && margin < 2) return t("The selected interval leaves a narrow {margin}× margin against feed rollover.", { margin });
  return t("{count} entries currently span {window}; the selected interval leaves a {margin}× margin.", { count: health.entryCount, window: formatCoverageMinutes(health.coverageMinutes || 0), margin: margin ?? "—" });
}
