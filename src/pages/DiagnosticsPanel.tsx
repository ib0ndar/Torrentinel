import { useEffect, useEffectEvent, useState } from "react";
import { api } from "../api";
import { Icon } from "../components/Icon";
import { PageNavigation } from "../components/Pagination";
import { ListSkeleton, TrackerTag } from "../components/UI";
import { deliveryMethodLabel, diagnosticStateClass, errorMessage, formatCoverageMinutes, formatDiagnosticDuration, relativeTime, trackerName } from "../format";
import { useI18n } from "../i18n";
import type { DiagnosticsView, DiagnosticsViewChange } from "../routing";
import type { DeliveriesResponse, NotificationQueueRow, Notify, ObservationsResponse, TrackerKey } from "../types";

// Filters and pages live in the URL (view); each list is paged on the server with the user's page size.
export function DiagnosticsPanel({ revision, notify, view, onViewChange, pageSize }: { revision: number; notify: Notify; view: DiagnosticsView; onViewChange: DiagnosticsViewChange; pageSize: number }) {
  const { t, language } = useI18n();
  const { tracker, outcome, page, deliveriesPage } = view;
  const [queue, setQueue] = useState<NotificationQueueRow[] | null>(null), [logs, setLogs] = useState<ObservationsResponse | null>(null), [deliveries, setDeliveries] = useState<DeliveriesResponse | null>(null);
  const [logsLoading, setLogsLoading] = useState(true), [deliveriesLoading, setDeliveriesLoading] = useState(true), [refresh, setRefresh] = useState(0);
  const fail = useEffectEvent((error: unknown) => notify(errorMessage(error), "bad"));
  // The server clamps pages past the end (e.g. after records expire); the URL follows without a new history entry.
  const clampPage = useEffectEvent((change: Partial<DiagnosticsView>) => onViewChange(change, { replace: true }));
  useEffect(() => {
    const controller = new AbortController();
    api<{ notificationQueue: NotificationQueueRow[] }>("/api/admin/diagnostics/queue", { signal: controller.signal })
      .then((result) => { if (!controller.signal.aborted) setQueue(result.notificationQueue); }).catch((error) => { if (!controller.signal.aborted) fail(error); });
    return () => controller.abort();
  }, [revision, refresh]);
  useEffect(() => {
    const controller = new AbortController(), query = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    if (tracker) query.set("trackerKey", tracker);
    if (outcome) query.set("outcome", outcome);
    setLogsLoading(true);
    api<ObservationsResponse>(`/api/admin/diagnostics/observations?${query}`, { signal: controller.signal }).then((result) => {
      if (controller.signal.aborted) return;
      setLogs(result); setLogsLoading(false);
      if (result.page !== page) clampPage({ page: result.page });
    }).catch((error) => { if (!controller.signal.aborted) { setLogsLoading(false); fail(error); } });
    return () => controller.abort();
  }, [revision, refresh, tracker, outcome, page, pageSize]);
  useEffect(() => {
    const controller = new AbortController();
    setDeliveriesLoading(true);
    api<DeliveriesResponse>(`/api/admin/diagnostics/deliveries?${new URLSearchParams({ page: String(deliveriesPage), pageSize: String(pageSize) })}`, { signal: controller.signal }).then((result) => {
      if (controller.signal.aborted) return;
      setDeliveries(result); setDeliveriesLoading(false);
      if (result.page !== deliveriesPage) clampPage({ deliveriesPage: result.page });
    }).catch((error) => { if (!controller.signal.aborted) { setDeliveriesLoading(false); fail(error); } });
    return () => controller.abort();
  }, [revision, refresh, deliveriesPage, pageSize]);
  const outcomes = [...new Set([...logs?.outcomes || [], ...outcome ? [outcome] : []])].sort();
  const subscription = (id: string, name?: string | null) => name || t("Subscription {id}", { id });
  return <>
    <section className="table-section diagnostic-section"><div className="section-heading"><div><h2>{t("Notification queue")}</h2><p>{t("Pending deliveries are persisted and retried automatically.")}</p></div></div>{!queue ? <ListSkeleton /> : !queue.length ? <div className="diagnostic-empty">{t("Queue is empty")}</div> : <div className="queue-table">{queue.map((row) => <div className="queue-row" key={row.id}><strong>{row.username}</strong><span className="queue-row__subscription" title={t("Subscription {id}", { id: row.subscriptionId })}>{subscription(row.subscriptionId, row.subscriptionName)}</span><span>{t("Attempts")}: {row.attempts}</span><span>{t("Next attempt")}: {relativeTime(row.nextAttemptAt)}</span><span className={`state ${diagnosticStateClass(row.status)}`}>{t(row.status)}</span><small>{row.lastError}</small></div>)}</div>}</section>
    <section className="table-section diagnostic-section"><div className="section-heading"><div><h2>{t("Tracker logs")}</h2><p>{t("Safe polling observations for investigating tracker behavior. Records expire after 168 hours.")}</p></div><div className="diagnostic-controls"><select aria-label={t("Filter logs by tracker")} value={tracker} onChange={(event) => onViewChange({ tracker: event.target.value as TrackerKey | "", page: 1 })}><option value="">{t("All trackers")}</option><option value="kinozal">Kinozal</option><option value="rutor">Rutor</option><option value="rutracker">RuTracker</option></select><select aria-label={t("Filter logs by outcome")} value={outcome} onChange={(event) => onViewChange({ outcome: event.target.value, page: 1 })}><option value="">{t("All outcomes")}</option>{outcomes.map((value) => <option key={value} value={value}>{t(value)}</option>)}</select><button type="button" className="button button--quiet" onClick={() => setRefresh((value) => value + 1)}><Icon name="refresh" />{t("Refresh")}</button></div></div>
      {logs && logs.pageCount > 1 && <nav className="pagination pagination--top" aria-label={t("Tracker log pages")}><PageNavigation page={logs.page} pageCount={logs.pageCount} total={logs.total} loading={logsLoading} onPageChange={(value) => onViewChange({ page: value })} /></nav>}
      {!logs ? <ListSkeleton /> : !logs.observations.length ? <div className="diagnostic-empty">{t("No tracker observations match these filters.")}</div> : <div className="diagnostic-table"><div className="diagnostic-head"><span>{t("Observed")}</span><span>{t("Source")}</span><span>{t("Operation")}</span><span>{t("Outcome")}</span><span>{t("Details")}</span><span>{t("Duration")}</span></div>{logs.observations.map((row) => {
        const url = row.resolvedUrl || row.requestedUrl, terms = typeof row.details.requiredTerms === "string" ? row.details.requiredTerms : undefined;
        const feedCount = numericDetail(row.details.feedEntryCount), feedBaseline = row.details.feedCoverageStatus === "baseline";
        const feedSummary = row.operation === "feed-poll" && feedCount !== undefined ? feedBaseline ? t("{count} feed entries seeded · overlap unavailable", { count: feedCount }) : [t("{count} feed entries scanned", { count: feedCount }), detailFragment(row.details.feedNewEntryCount, "new"), detailFragment(row.details.feedOverlapCount, "overlap")].filter(Boolean).join(" · ") : undefined;
        const ruleSummary = terms ? t("Rule evaluated: {terms}", { terms }) : undefined;
        const detail = row.title || ruleSummary || feedSummary || row.errorMessage || (row.releaseCount !== null && row.releaseCount !== undefined ? t("{count} releases observed", { count: row.releaseCount }) : t("Tracker request completed"));
        const coverage = row.operation === "feed-poll" ? numericDetail(row.details.feedCoverageMinutes) : undefined;
        const matched = numericDetail(row.details.matchedCount), newMatches = numericDetail(row.details.newMatchCount);
        const meta = [row.errorMessage, ruleSummary && matched !== undefined ? t("{count} matched", { count: matched }) : "", ruleSummary && newMatches !== undefined ? t("{count} new matches", { count: newMatches }) : "", coverage !== undefined ? t("{window} feed window", { window: formatCoverageMinutes(coverage) }) : "", row.httpStatus ? `HTTP ${row.httpStatus}` : "", row.externalId ? `ID ${row.externalId}` : ""].filter(Boolean).join(" · ");
        const source = `${row.username}${row.subscriptionId ? ` · ${subscription(row.subscriptionId, row.subscriptionName)}` : ""}`;
        return <div className="diagnostic-row" key={row.id}><span className="diagnostic-time" title={new Date(row.observedAt).toLocaleString(language)}>{relativeTime(row.observedAt)}</span><span className="diagnostic-source"><TrackerTag tracker={row.trackerKey} /><span><strong>{trackerName(row.trackerKey)}</strong><small title={source}>{source}</small></span></span><span className="diagnostic-operation">{t(row.operation)}</span><span className="diagnostic-outcome"><span className={`state ${diagnosticStateClass(row.outcome)}`} title={t(row.outcome)}>{t(row.outcome)}</span></span><span className="diagnostic-detail"><strong>{detail}</strong><small>{meta}</small>{url && <a href={url} target="_blank" rel="noreferrer">{url}</a>}</span><span className="diagnostic-duration">{formatDiagnosticDuration(row.durationMs)}</span></div>;
      })}</div>}
      {logs && logs.pageCount > 1 && <nav className="pagination pagination--bottom" aria-label={t("Tracker log pages, bottom")}><PageNavigation page={logs.page} pageCount={logs.pageCount} total={logs.total} loading={logsLoading} onPageChange={(value) => onViewChange({ page: value })} announce={false} /></nav>}
    </section>
    <section className="table-section diagnostic-section"><div className="section-heading"><div><h2>{t("Telegram deliveries")}</h2><p>{t("Delivery receipts and failures for subscription notifications. Records expire after 168 hours.")}</p></div></div>
      {deliveries && deliveries.pageCount > 1 && <nav className="pagination pagination--top" aria-label={t("Telegram delivery pages")}><PageNavigation page={deliveries.page} pageCount={deliveries.pageCount} total={deliveries.total} loading={deliveriesLoading} onPageChange={(value) => onViewChange({ deliveriesPage: value })} /></nav>}
      {!deliveries ? <ListSkeleton /> : !deliveries.telegramDeliveries.length ? <div className="diagnostic-empty">{t("No Telegram notifications have been attempted during the retention window.")}</div> : <div className="diagnostic-table diagnostic-table--telegram"><div className="diagnostic-head telegram-delivery-grid"><span>{t("Sent")}</span><span>{t("Account")}</span><span>{t("Source")}</span><span>{t("Delivery")}</span><span>{t("Outcome")}</span><span>{t("Release")}</span><span>{t("Duration")}</span></div>{deliveries.telegramDeliveries.map((row) => {
        const detail = row.errorMessage || row.title || t("General notification"), receipt = row.telegramMessageId ? t("Telegram message #{id}", { id: row.telegramMessageId }) : t("No delivery receipt"), note = row.artworkErrorMessage ? t("Artwork fallback: {error} · {receipt}", { error: row.artworkErrorMessage, receipt }) : receipt;
        return <div className="diagnostic-row telegram-delivery-grid" key={row.id}><span className="diagnostic-time" title={new Date(row.createdAt).toLocaleString(language)}>{relativeTime(row.createdAt)}</span><span className="diagnostic-detail"><strong>{row.username}</strong><small>{row.subscriptionId ? subscription(row.subscriptionId, row.subscriptionName) : t("Account message")}</small></span><span className="diagnostic-source">{row.trackerKey ? <><TrackerTag tracker={row.trackerKey} /><span><strong>{trackerName(row.trackerKey)}</strong><small>{row.externalId ? `ID ${row.externalId}` : t("Release")}</small></span></> : <span><strong>{t("System")}</strong><small>Telegram</small></span>}</span><span className="diagnostic-operation">{deliveryMethodLabel(row.deliveryMethod)}</span><span className="diagnostic-outcome"><span className={`state ${diagnosticStateClass(row.outcome)}`} title={t(row.outcome)}>{t(row.outcome)}</span></span><span className="diagnostic-detail"><strong title={detail}>{detail}</strong><small title={note}>{note}</small></span><span className="diagnostic-duration">{formatDiagnosticDuration(row.durationMs)}</span></div>;
      })}</div>}
      {deliveries && deliveries.pageCount > 1 && <nav className="pagination pagination--bottom" aria-label={t("Telegram delivery pages, bottom")}><PageNavigation page={deliveries.page} pageCount={deliveries.pageCount} total={deliveries.total} loading={deliveriesLoading} onPageChange={(value) => onViewChange({ deliveriesPage: value })} announce={false} /></nav>}
    </section>
  </>;
  function detailFragment(value: unknown, label: string): string | undefined { const number = numericDetail(value); return number === undefined ? undefined : `${number} ${t(label)}`; }
}
function numericDetail(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
