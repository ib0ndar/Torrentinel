import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { api, jsonBody } from "../api";
import { ChangeSummary } from "../components/ChangeDetails";
import { useDialog } from "../components/Dialogs";
import { Icon } from "../components/Icon";
import { EmptyState, FilterTabs, ListSkeleton, Page, PhraseDisplay, SubscriptionTypeIcon, TrackerTag } from "../components/UI";
import { moveRowFocus, useKeyboardShortcuts } from "../hooks/useKeyboardShortcuts";
import { useVisibleInterval } from "../hooks/useVisibleInterval";
import { absoluteTime, errorMessage, relativeTime } from "../format";
import { getLanguage, useI18n } from "../i18n";
import type { ActivityFilter } from "../routing";
import type { ActivityEvent, ActivityReminder, Collection, Notify, User } from "../types";
import { SubscriptionInspector } from "./SubscriptionInspector";

type ActivityResponse = { events: ActivityEvent[]; total: number; page: number; pageCount: number; reminders?: ActivityReminder[] };
const dayKey = (value: string) => { const date = new Date(value); return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`; };

export function Activity({ user, notify, filter, onFilterChange, collections, onCollectionsChanged, onShowShortcuts }: {
  user: User; notify: Notify; filter: ActivityFilter; onFilterChange: (filter: ActivityFilter) => void; collections: Collection[]; onCollectionsChanged: () => Promise<void>; onShowShortcuts?: () => void;
}) {
  const { t } = useI18n(), dialog = useDialog();
  const [events, setEvents] = useState<ActivityEvent[]>([]), [reminders, setReminders] = useState<ActivityReminder[]>([]), [total, setTotal] = useState(0), [loading, setLoading] = useState(true), [loadingMore, setLoadingMore] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const pages = useRef(1), request = useRef<AbortController | null>(null);
  const unreadSubscriptions = collections.reduce((sum, collection) => sum + collection.unreadCount, 0);
  // Same total as the navigation badge: unread changes plus Mark unread reminders.
  const unreadTotal = collections.reduce((sum, collection) => sum + collection.activityCount, 0);
  useKeyboardShortcuts({ "?": onShowShortcuts, j: () => moveRowFocus(".activity-entry", 1), k: () => moveRowFocus(".activity-entry", -1) });
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
      setReminders(results[0]?.reminders ?? []);
      pages.current = Math.max(1, Math.min(pages.current, results[0]?.pageCount ?? 1));
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [filter, user.pageSize]);
  const refresh = useCallback(() => load().catch((error) => notify(errorMessage(error), "bad")), [load, notify]);
  useEffect(() => { void refresh(); return () => request.current?.abort(); }, [refresh]);
  useVisibleInterval(refresh, 30_000);
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
  const counts = filter === "unread"
    ? [total > 0 ? t(total === 1 ? "{count} unread change" : "{count} unread changes", { count: total }) : "", reminders.length > 0 ? t("{count} marked unread", { count: reminders.length }) : ""].filter(Boolean).join(" · ")
    : total > 0 ? t(total === 1 ? "{count} change" : "{count} changes", { count: total }) : "";
  return <Page eyebrow={t("All collections")} title={t("Activity")} description={t("Changes across your collections, newest first. Open an entry to see its details and mark it read.")}
    actions={<button className="button button--quiet activity-read" disabled={!unreadSubscriptions} onClick={() => void markAllRead()}><Icon name="check" size={16} />{t("Mark all read")}</button>}>
    <div className="list-toolbar activity-toolbar"><FilterTabs label={t("Filter changes")} options={[{ value: "unread" as const, label: t("Unread"), count: unreadTotal }, { value: "all" as const, label: t("All") }]} value={filter} onChange={onFilterChange} />
      {!loading && counts && <span className="activity-count">{counts}</span>}</div>
    {loading ? <ListSkeleton /> : events.length === 0 && reminders.length === 0 ? (filter === "unread"
      ? <EmptyState icon="check" title={t("You’re all caught up")} text={t("New changes from all your collections will appear here.")} action={<button className="button button--quiet" onClick={() => onFilterChange("all")}>{t("Show all changes")}</button>} />
      : <EmptyState icon="clock" title={t("No changes yet")} text={t("Changes will appear here after the baseline.")} />)
      : <div data-focus-list>{reminders.length > 0 && <section className="activity-day activity-reminders"><h2>{t("Marked unread")}</h2><div className="activity-list">{reminders.map((reminder) => <ReminderEntry key={reminder.subscription.id} reminder={reminder} onOpen={() => setOpenId(reminder.subscription.id)} />)}</div></section>}
        {groups.map((group) => <section className="activity-day" key={group.key}><h2>{group.label}</h2><div className="activity-list">{group.events.map((event) => <ActivityEntry key={event.id} event={event} onOpen={() => setOpenId(event.subscription.id)} />)}</div></section>)}
        {events.length < total && <div className="activity-more"><button className="button button--quiet" disabled={loadingMore} onClick={() => void loadMore()}>{t("Load more")}</button></div>}</div>}
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
  return <ActivityRow item={event} unread={event.isUnread} summary={<ChangeSummary event={event} />} time={event.createdAt} onOpen={onOpen} />;
}
function ReminderEntry({ reminder, onOpen }: { reminder: ActivityReminder; onOpen: () => void }) {
  const { t } = useI18n();
  return <ActivityRow item={reminder} unread summary={<span className="change-summary">{t("Marked unread by you")}</span>} time={reminder.lastChangedAt || undefined} onOpen={onOpen} />;
}
function ActivityRow({ item, unread, summary, time, onOpen }: { item: Pick<ActivityEvent, "subscription" | "collection">; unread: boolean; summary: ReactNode; time?: string; onOpen: () => void }) {
  const { t } = useI18n(), { subscription } = item;
  return <button type="button" className={`activity-entry ${unread ? "activity-entry--unread" : ""}`} data-focus-item onClick={onOpen}>
    <SubscriptionTypeIcon type={subscription.type} unread={unread} />
    <span className="activity-entry__main">
      <span className="activity-entry__label">{subscription.type === "rule" ? <PhraseDisplay phrases={subscription.requiredTerms} /> : <strong>{subscription.label === "Direct subscription" ? t(subscription.label) : subscription.label}</strong>}</span>
      {summary}
      <span className="activity-entry__meta"><span className="activity-entry__collection"><Icon name="folder" size={13} />{item.collection.name}</span><span className="tracker-stack">{subscription.trackerKeys.map((key) => <TrackerTag key={key} tracker={key} />)}</span></span>
    </span>
    {time ? <time className="activity-entry__time" dateTime={time} title={absoluteTime(time)}>{relativeTime(time)}</time> : <span />}
  </button>;
}
