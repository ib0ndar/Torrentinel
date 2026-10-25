import { type FormEvent, type MouseEvent, useCallback, useContext, useEffect, useEffectEvent, useRef, useState } from "react";
import { api, ApiError, jsonBody } from "../api";
import { ChangeDetails } from "../components/ChangeDetails";
import { useDialog } from "../components/Dialogs";
import { CheckActivityContext } from "../components/contexts";
import { Icon } from "../components/Icon";
import { useTrackers } from "../hooks/useTrackers";
import { useVisibleInterval } from "../hooks/useVisibleInterval";
import { Drawer, EmptyCompact, Field, ListSkeleton, Page, PhraseInput, ReleaseCover, TrackerTag } from "../components/UI";
import { absoluteTime, errorMessage, magnetHref, relativeTime, webHref } from "../format";
import { useI18n } from "../i18n";
import { usePageTitle } from "../pageTitle";
import { isPlainClick, MONITOR_HOME, type Navigate } from "../routing";
import type { Collection, Notify, RuleMatch, Subscription, SubscriptionEvent, TrackerKey } from "../types";

function withSafeLinks(subscription: Subscription): Subscription {
  const snapshot = subscription.currentSnapshot;
  return snapshot ? { ...subscription, currentSnapshot: { ...snapshot, url: webHref(snapshot.url), coverUrl: webHref(snapshot.coverUrl), magnet: magnetHref(snapshot.magnet), torrentUrl: webHref(snapshot.torrentUrl) } } : subscription;
}

// As a page (standalone), a breadcrumb leads back to the last Monitor view and to the subscription's collection.
export function SubscriptionInspector({ id, collections, onClose, onChanged, notify, standalone = false, monitorHref = MONITOR_HOME, collectionHref, navigate }: { id: string; collections: Collection[]; onClose: () => void; onChanged: () => Promise<void>; notify: Notify; standalone?: boolean; monitorHref?: string; collectionHref?: (id: string) => string; navigate?: Navigate }) {
  const { t } = useI18n(), dialog = useDialog(), trackCheck = useContext(CheckActivityContext);
  const [item, setItem] = useState<Subscription | null>(null), [events, setEvents] = useState<SubscriptionEvent[]>([]), [matches, setMatches] = useState<RuleMatch[]>([]);
  const [busy, setBusy] = useState(false), [editing, setEditing] = useState(false);
  // A failed first load is shown in place of the details, once; a missing subscription gets a way back.
  const [loadError, setLoadError] = useState<{ message: string; missing: boolean } | null>(null);
  const endpoint = `/api/subscriptions/${encodeURIComponent(id)}`;
  // Fixed action columns: a column exists when any match has that action, so icons line up across rows.
  const actionSlots = { magnet: matches.some((match) => match.magnet), torrent: matches.some((match) => match.torrentUrl) };
  const load = useCallback(async (opening = false, signal?: AbortSignal) => {
    const result = await api<{ subscription: Subscription; events: SubscriptionEvent[]; matches: RuleMatch[] }>(`${endpoint}${opening ? "/open" : ""}`, { ...(opening ? { method: "POST" } : {}), signal });
    if (signal?.aborted) return;
    setLoadError(null); setItem(withSafeLinks(result.subscription)); setEvents(result.events);
    setMatches(result.matches.map((match) => ({ ...match, url: webHref(match.url) || "#", magnet: magnetHref(match.magnet), torrentUrl: webHref(match.torrentUrl) })));
  }, [endpoint]);
  const onOpened = useEffectEvent(() => onChanged()), onOpenError = useEffectEvent((error: unknown) => setLoadError({ message: errorMessage(error), missing: error instanceof ApiError && error.status === 404 }));
  useEffect(() => { const controller = new AbortController(); void load(true, controller.signal).then(() => { if (!controller.signal.aborted) return onOpened(); }).catch((error) => { if (!controller.signal.aborted) onOpenError(error); }); return () => controller.abort(); }, [load]);
  const poll = useRef<AbortController | null>(null);
  const refreshDetails = useCallback(() => { poll.current?.abort(); const controller = new AbortController(); poll.current = controller; void load(false, controller.signal).catch(() => undefined); }, [load]);
  useVisibleInterval(refreshDetails, 30_000);
  useEffect(() => () => poll.current?.abort(), [load]);
  async function update(payload: Record<string, unknown>, message: string) {
    setBusy(true);
    try { await api(endpoint, { method: "PATCH", ...jsonBody(payload) }); await Promise.all([load(), onChanged()]); notify(message); return true; }
    catch (error) { notify(errorMessage(error), "bad"); return false; } finally { setBusy(false); }
  }
  async function checkNow() {
    setBusy(true);
    try { await trackCheck(api(`${endpoint}/check`, { method: "POST" })); await Promise.all([load(), onChanged()]); notify(t("Tracker check completed")); }
    catch (error) { notify(errorMessage(error), "bad"); } finally { setBusy(false); }
  }
  async function markRead() {
    if (!item) return;
    setBusy(true);
    try { await api(`${endpoint}/read`, { method: "POST", ...jsonBody({ read: item.isUnread }) }); await Promise.all([load(), onChanged()]); }
    catch (error) { notify(errorMessage(error), "bad"); } finally { setBusy(false); }
  }
  async function remove() {
    if (!item) return;
    if (!await dialog.confirm({ eyebrow: t(item.type === "rule" ? "Delete rule" : "Delete subscription"),
      title: item.type === "rule" ? t("Delete this rule?") : t("Delete “{name}”?", { name: item.label }),
      description: t(item.type === "rule" ? "This permanently removes the rule, its matches, and its change history. This action cannot be undone." : "This permanently removes the subscription and its change history. This action cannot be undone."),
      confirmLabel: t(item.type === "rule" ? "Delete rule" : "Delete subscription"), tone: "danger" })) return;
    try { await api(endpoint, { method: "DELETE" }); await onChanged(); onClose(); notify(t("Subscription deleted")); }
    catch (error) { notify(errorMessage(error), "bad"); }
  }
  const content = !item ? loadError?.missing ? <div className="missing-actions"><button type="button" className="button button--quiet" onClick={onClose}>{standalone ? <><Icon name="monitor" />{t("Back to Monitor")}</> : t("Close")}</button></div>
    : loadError ? <div className="error-strip" role="alert"><Icon name="alert" />{loadError.message}</div> : <ListSkeleton /> : <div className="inspector">
      <div className="inspector-status"><span className={`status-dot ${item.enabled && !item.lastError ? "status-dot--live" : ""}`} /><div><strong>{t(item.lastError ? "Needs attention" : !item.enabled ? "Paused" : !item.initialized ? "Learning" : "Watching")}</strong><span>{item.lastCheckedAt ? t("Last checked {time}", { time: relativeTime(item.lastCheckedAt) }) : t("Waiting for first check")}</span></div><button className="button button--quiet" disabled={busy} onClick={checkNow}><Icon name="refresh" />{t("Check now")}</button></div>
      {item.lastError && <div className="error-strip"><Icon name="alert" />{item.lastError}</div>}
      <section className="detail-section"><div className="section-heading"><h3>{t("Configuration")}</h3><button className="text-button" onClick={() => setEditing((value) => !value)}>{t(editing ? "Cancel" : "Edit")}</button></div>{editing ? <EditSubscriptionForm item={item} collections={collections} busy={busy} notify={notify} onCancel={() => setEditing(false)} onSave={async (payload) => { if (await update(payload, t("Subscription configuration saved"))) setEditing(false); }} /> : <dl className="detail-grid">
        <div><dt>{t("Collection")}</dt><dd>{collections.find((collection) => collection.id === item.collectionId)?.name ?? "—"}</dd></div>
        <div><dt>{t("Sources")}</dt><dd className="tracker-stack">{item.trackerKeys.map((key) => <TrackerTag key={key} tracker={key} />)}</dd></div>
        {item.type === "rule" && <><div><dt>{t("Required")}</dt><dd>{item.requiredTerms.join(" · ")}</dd></div><div><dt>{t("Ignored")}</dt><dd>{item.ignoredTerms.join(" · ") || t("None")}</dd></div></>}
      </dl>}</section>
      {item.type === "direct" && <section className="detail-section"><div className="release-actions"><h3>{t("Release")}</h3><div className="source-links"><a href={item.currentSnapshot?.url || item.directUrl || "#"} target="_blank" rel="noreferrer"><Icon name="external" />{t("Tracker page")}</a>{item.currentSnapshot?.magnet && <a href={item.currentSnapshot.magnet}><Icon name="magnet" />{t("Magnet")}</a>}{item.currentSnapshot?.torrentUrl && <a href={item.currentSnapshot.torrentUrl} target="_blank" rel="noreferrer"><Icon name="download" />{t("Torrent file")}</a>}</div></div></section>}
      {item.type === "rule" && <section className="detail-section"><div className="section-heading"><h3>{t("Matches")}</h3><span>{matches.length}</span></div>{matches.length ? <div className="match-list">{matches.map((match) => <div className="match-row" key={match.id}><TrackerTag tracker={match.trackerKey} /><a className="match-row__title" href={match.url} target="_blank" rel="noreferrer"><span><span className="match-row__name"><strong>{match.title}</strong><Icon name="external" size={13} /></span><small>{relativeTime(match.discoveredAt)}</small></span></a>
        {actionSlots.magnet || actionSlots.torrent ? <span className="match-row__actions">{actionSlots.magnet && (match.magnet ? <a href={match.magnet} aria-label={t("Open magnet for {title}", { title: match.title })} title={t("Magnet")}><Icon name="magnet" size={16} /></a> : <span className="match-row__slot" aria-hidden="true" />)}{actionSlots.torrent && (match.torrentUrl ? <a href={match.torrentUrl} target="_blank" rel="noreferrer" aria-label={t("Download torrent file for {title}", { title: match.title })} title={t("Torrent file")}><Icon name="download" size={16} /></a> : <span className="match-row__slot" aria-hidden="true" />)}</span> : null}</div>)}</div> : <EmptyCompact text={t(item.initialized ? "No new releases matched this rule yet." : "The first baseline scan is pending.")} />}</section>}
      <section className="detail-section"><div className="section-heading"><h3>{t("Change history")}</h3><span>{events.length}</span></div>{events.length ? <div className="timeline">{events.map((event) => <div className="timeline-item" key={event.id}><span className={!event.readAt ? "timeline-dot timeline-dot--new" : "timeline-dot"} /><div><ChangeDetails event={event} /><small title={absoluteTime(event.createdAt)}>{relativeTime(event.createdAt)}</small></div></div>)}</div> : <EmptyCompact text={t("Changes will appear here after the baseline.")} />}</section>
      <section className="detail-section detail-section--actions"><button className="button button--quiet" disabled={busy} onClick={markRead}>{t(item.isUnread ? "Mark read" : "Mark unread")}</button><button className="button button--quiet" disabled={busy} onClick={() => void update({ enabled: !item.enabled }, t(item.enabled ? "Subscription paused" : "Subscription resumed"))}>{t(item.enabled ? "Pause" : "Resume")}</button><button className="button button--danger" disabled={busy} onClick={() => void remove()}><Icon name="trash" />{t("Delete")}</button></section>
    </div>;
  const title = item?.label || t(loadError?.missing ? "Subscription not found" : "Subscription");
  const subtitle = item ? t(item.type === "direct" ? "Direct subscription" : "Rule subscription") : loadError ? undefined : t("Loading details");
  const missingNote = loadError?.missing ? t("It may have been deleted, or the link is incomplete.") : undefined;
  usePageTitle(standalone ? title : null);
  const cover = item?.type === "direct" && item.currentSnapshot?.coverUrl ? <ReleaseCover key={item.currentSnapshot.coverUrl} url={item.currentSnapshot.coverUrl} title={item.currentSnapshot.title || item.label} thumbnail /> : undefined;
  if (standalone) {
    const collection = item && collections.find((entry) => entry.id === item.collectionId);
    const follow = (href: string) => (event: MouseEvent<HTMLAnchorElement>) => { if (navigate && isPlainClick(event)) { event.preventDefault(); navigate(href); } };
    const breadcrumb = <nav className="breadcrumb" aria-label={t("Breadcrumb")}><ol>
      <li><a href={monitorHref} onClick={follow(monitorHref)}>{t("Monitor")}</a></li>
      {collection && collectionHref && <li><a href={collectionHref(collection.id)} onClick={follow(collectionHref(collection.id))}>{collection.name}</a></li>}
    </ol></nav>;
    return <Page className="page--subscription" title={title} breadcrumb={breadcrumb} description={subtitle ?? missingNote}>{cover}{content}</Page>;
  }
  return <Drawer title={title} eyebrow={subtitle} description={missingNote} onClose={onClose} extraWide headerMedia={cover}>
    {content}
  </Drawer>;
}
// Only changed fields are sent: saving rule phrases or trackers starts a new baseline, moving to another collection does not.
function EditSubscriptionForm({ item, collections, busy, notify, onCancel, onSave }: { item: Subscription; collections: Collection[]; busy: boolean; notify: Notify; onCancel: () => void; onSave: (payload: Record<string, unknown>) => Promise<void> }) {
  const { t } = useI18n();
  const { trackers } = useTrackers((error) => notify(errorMessage(error), "bad"));
  const [collectionId, setCollectionId] = useState(item.collectionId), [url, setUrl] = useState(item.directUrl || ""), [required, setRequired] = useState<string[]>(item.requiredTerms), [ignored, setIgnored] = useState<string[]>(item.ignoredTerms), [trackerKeys, setTrackerKeys] = useState<TrackerKey[]>(item.trackerKeys);
  const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((value, index) => value === b[index]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    const payload: Record<string, unknown> = { ...collectionId !== item.collectionId ? { collectionId } : {} };
    if (item.type === "direct" && url !== (item.directUrl || "")) payload.url = url;
    if (item.type === "rule" && (!same(required, item.requiredTerms) || !same(ignored, item.ignoredTerms) || !same([...trackerKeys].sort(), [...item.trackerKeys].sort()))) Object.assign(payload, { requiredTerms: required, ignoredTerms: ignored, trackerKeys });
    if (Object.keys(payload).length) await onSave(payload); else onCancel();
  }
  const collectionField = <Field label={t("Collection")}><select value={collectionId} onChange={(event) => setCollectionId(event.target.value)}>{collections.map((collection) => <option key={collection.id} value={collection.id}>{collection.name}</option>)}</select></Field>;
  return <form className="edit-subscription" onSubmit={submit}>{collectionField}{item.type === "direct" ? <Field label={t("Tracker page URL")}><input type="url" value={url} onChange={(event) => setUrl(event.target.value)} required /></Field> : <>
    <Field label={t("Trackers")}><div className="tracker-picker">{trackers?.filter((tracker) => tracker.capabilities.rules).map(({ key, displayName }) => <label key={key} className={trackerKeys.includes(key) ? "tracker-choice tracker-choice--active" : "tracker-choice"}><input type="checkbox" checked={trackerKeys.includes(key)} onChange={() => setTrackerKeys((current) => current.includes(key) ? current.filter((selected) => selected !== key) : [...current, key])} /><TrackerTag tracker={key} /><span>{displayName}</span></label>)}</div></Field>
    <Field label={t("Required phrases")} hint={t("Press Enter to add")}><PhraseInput ariaLabel={t("Required phrases")} value={required} onChange={setRequired} placeholder={t("Type a phrase and press Enter")} /></Field><Field label={t("Ignored phrases")} hint={t("Press Enter to add")}><PhraseInput ariaLabel={t("Ignored phrases")} value={ignored} onChange={setIgnored} placeholder={t("Type a phrase and press Enter")} /></Field>
  </>}<div className="inline-actions"><button type="button" className="button button--quiet" onClick={onCancel}>{t("Cancel")}</button><button className="button button--primary" disabled={busy || (item.type === "rule" && (!required.length || !trackerKeys.length))}>{t("Save changes")}</button></div></form>;
}
