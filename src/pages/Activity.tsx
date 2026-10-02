import { useCallback, useEffect, useRef, useState } from "react";
import { api, jsonBody } from "../api";
import { ChangeSummary } from "../components/ChangeDetails";
import { useDialog } from "../components/Dialogs";
import { Icon } from "../components/Icon";
import { EmptyState, ListSkeleton, Page, PhraseDisplay, SubscriptionTypeIcon, TrackerTag } from "../components/UI";
import { absoluteTime, errorMessage, relativeTime } from "../format";
import { getLanguage, useI18n } from "../i18n";
import type { ActivityFilter } from "../routing";
import type { ActivityEvent, Collection, Notify, User } from "../types";
import { SubscriptionInspector } from "./SubscriptionInspector";

type ActivityResponse = { events: ActivityEvent[]; total: number; page: number; pageCount: number };
const dayKey = (value: string) => { const date = new Date(value); return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`; };

export function Activity({ user, notify, filter, onFilterChange, collections, onCollectionsChanged }: {
  user: User; notify: Notify; filter: ActivityFilter; onFilterChange: (filter: ActivityFilter) => void; collections: Collection[]; onCollectionsChanged: () => Promise<void>;
}) {
  const { t } = useI18n(), dialog = useDialog();
  const [events, setEvents] = useState<ActivityEvent[]>([]), [total, setTotal] = useState(0), [loading, setLoading] = useState(true), [loadingMore, setLoadingMore] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const pages = useRef(1), request = useRef<AbortController | null>(null);
  const unreadSubscriptions = collections.reduce((sum, collection) => sum + collection.unreadCount, 0);
  // "Load more" keeps every loaded page; refreshes reload them all so read entries drop out without gaps.
  const load = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    try {
      const results = await Promise.all(Array.from({ length: pages.current }, (_, index) => api<ActivityResponse>(
        `/api/activity?${new URLSearchParams({ filter, page: String(index + 1), pageSize: String(user.pageSize) })}`, { signal: controller.signal })));
      if (controller.signal.aborted) return;
      const seen = new Set<string>();
      setEvents(results.flatMap((result) => result.events).filter((event) => !seen.has(event.id) && Boolean(seen.add(event.id))));
      setTotal(results[0]?.total ?? 0);
      pages.current = Math.max(1, Math.min(pages.current, results[0]?.pageCount ?? 1));
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [filter, user.pageSize]);
  const refresh = useCallback(() => load().catch((error) => notify(errorMessage(error), "bad")), [load, notify]);
  useEffect(() => { void refresh(); return () => request.current?.abort(); }, [refresh]);
  useEffect(() => { const timer = window.setInterval(() => void refresh(), 30_000); return () => window.clearInterval(timer); }, [refresh]);
  async function loadMore() {
    pages.current += 1; setLoadingMore(true);
    try { await refresh(); } finally { setLoadingMore(false); }
  }
  const changed = useCallback(async () => { await Promise.all([refresh(), onCollectionsChanged()]); }, [refresh, onCollectionsChanged]);
  async function markAllRead() {
    if (!await dialog.confirm({ eyebrow: t("Mark all read"), title: t("Mark everything as read?"),
      description: t(unreadSubscriptions === 1 ? "One unread subscription across all collections will be marked read. Reminders set with Mark unread are cleared too." : "{count} unread subscriptions across all collections will be marked read. Reminders set with Mark unread are cleared too.", { count: unreadSubscriptions }),
      confirmLabel: t("Mark all read") })) return;
    try { await api("/api/activity/read", { method: "POST", ...jsonBody({}) }); await changed(); notify(t("Everything marked read")); }
    catch (error) { notify(errorMessage(error), "bad"); }
  }
  const groups: Array<{ key: string; label: string; events: ActivityEvent[] }> = [];
  for (const event of events) {
    const key = dayKey(event.createdAt), group = groups.at(-1);
    if (group?.key === key) group.events.push(event); else groups.push({ key, label: dayLabel(event.createdAt), events: [event] });
  }
  return <Page eyebrow={t("All collections")} title={t("Activity")} description={t("Changes across your collections, newest first. Open an entry to see its details and mark it read.")}
    actions={<button className="button button--quiet activity-read" disabled={!unreadSubscriptions} onClick={() => void markAllRead()}><Icon name="check" size={16} />{t("Mark all read")}</button>}>
    <div className="list-toolbar activity-toolbar"><div className="filter-tabs">{(["unread", "all"] as const).map((name) => <button key={name} className={filter === name ? "active" : ""} onClick={() => onFilterChange(name)}>{t(name === "unread" ? "Unread" : "All")}</button>)}</div>
      {!loading && total > 0 && <span className="activity-count">{t(filter === "unread" ? "{count} unread changes" : "{count} changes", { count: total })}</span>}</div>
    {loading ? <ListSkeleton /> : events.length === 0 ? (filter === "unread"
      ? <EmptyState icon="check" title={t("You’re all caught up")} text={t("New changes from all your collections will appear here.")} action={<button className="button button--quiet" onClick={() => onFilterChange("all")}>{t("Show all changes")}</button>} />
      : <EmptyState icon="clock" title={t("No changes yet")} text={t("Changes will appear here after the baseline.")} />)
      : <>{groups.map((group) => <section className="activity-day" key={group.key}><h2>{group.label}</h2><div className="activity-list">{group.events.map((event) => <ActivityEntry key={event.id} event={event} onOpen={() => setOpenId(event.subscription.id)} />)}</div></section>)}
        {events.length < total && <div className="activity-more"><button className="button button--quiet" disabled={loadingMore} onClick={() => void loadMore()}>{t("Load more")}</button></div>}</>}
    {openId && <SubscriptionInspector key={openId} id={openId} collections={collections} onClose={() => setOpenId(null)} onChanged={changed} notify={notify} />}
  </Page>;
  function dayLabel(value: string): string {
    const date = new Date(value), today = new Date(), start = (day: Date) => new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
    const days = Math.round((start(today) - start(date)) / 86_400_000);
    if (days === 0) return t("Today");
    if (days === 1) return t("Yesterday");
    return date.toLocaleDateString(getLanguage(), { weekday: "long", day: "numeric", month: "long", year: date.getFullYear() === today.getFullYear() ? undefined : "numeric" });
  }
}
function ActivityEntry({ event, onOpen }: { event: ActivityEvent; onOpen: () => void }) {
  const { t } = useI18n(), { subscription } = event;
  return <button type="button" className={`activity-entry ${event.isUnread ? "activity-entry--unread" : ""}`} onClick={onOpen}>
    <SubscriptionTypeIcon type={subscription.type} unread={event.isUnread} />
    <span className="activity-entry__main">
      <span className="activity-entry__label">{subscription.type === "rule" ? <PhraseDisplay phrases={subscription.requiredTerms} /> : <strong>{subscription.label === "Direct subscription" ? t(subscription.label) : subscription.label}</strong>}</span>
      <ChangeSummary event={event} />
      <span className="activity-entry__meta"><span className="activity-entry__collection"><Icon name="folder" size={13} />{event.collection.name}</span><span className="tracker-stack">{subscription.trackerKeys.map((key) => <TrackerTag key={key} tracker={key} />)}</span></span>
    </span>
    <time className="activity-entry__time" dateTime={event.createdAt} title={absoluteTime(event.createdAt)}>{relativeTime(event.createdAt)}</time>
  </button>;
}
