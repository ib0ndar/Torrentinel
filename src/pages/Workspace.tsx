import { type CSSProperties, type FormEvent, useEffect, useState } from "react";
import { api, jsonBody } from "../api";
import type { WorkspaceData } from "../hooks/useWorkspaceData";
import { useDialog } from "../components/Dialogs";
import { Icon } from "../components/Icon";
import { MenuButton } from "../components/Menu";
import { Drawer, DrawerActions, EmptyState, Field, InfoLine, ListSkeleton, PhraseDisplay, PhraseInput, TrackerTag } from "../components/UI";
import { capitalize, errorMessage, relativeTime } from "../format";
import { useI18n } from "../i18n";
import { SubscriptionInspector } from "./SubscriptionInspector";
import type { Collection, Notify, SubscriptionSummary, Tracker, TrackerKey, User } from "../types";
import { PAGE_SIZE_OPTIONS } from "../types";
import { PageNavigation } from "../components/Pagination";

const DEFAULT_IGNORED_PHRASES = ["Trailer", "Трейлер", "Teaser", "Тизер", "Soundtrack", "Саундтрек"];
export function Workspace({ user, onUserChange, notify, data, onNewCollection }: { user: User; onUserChange: (user: User) => void; notify: Notify; data: WorkspaceData; onNewCollection: () => void }) {
  const { t } = useI18n(), dialog = useDialog();
  const { collections, selectedId, setSelectedId, subscriptions, loading, loadCollections, refresh, filter, setFilter, page, setPage, total, pageCount } = data;
  const [search, setSearch] = useState(data.search);
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedSubscription, setSelectedSubscription] = useState<string | null>(null);
  const [savingSize, setSavingSize] = useState(false);
  // Debounce only typing, not collection/page navigation. Search always covers
  // the complete collection on the server, including off-page records.
  useEffect(() => {
    const timer = window.setTimeout(() => data.setSearch(search), 250);
    return () => window.clearTimeout(timer);
  }, [search]);
  const selected = collections.find((collection) => collection.id === selectedId);
  async function renameCollection() {
    if (!selected) return;
    const name = (await dialog.prompt({ eyebrow: t("Edit collection"), title: t("Rename collection"), description: t("Choose a short name that makes this collection easy to find."),
      inputLabel: t("Collection name"), initialValue: selected.name, maxLength: 80, confirmLabel: t("Rename") }))?.trim();
    if (!name || name === selected.name) return;
    try { await api(`/api/collections/${selected.id}`, { method: "PATCH", ...jsonBody({ name }) }); await loadCollections(); notify(t("Collection renamed")); }
    catch (error) { notify(errorMessage(error), "bad"); }
  }
  async function deleteCollection() {
    if (!selected) return;
    if (!await dialog.confirm({ eyebrow: t("Delete collection"), title: t("Delete “{name}”?", { name: selected.name }),
      description: t("This permanently removes the collection and every subscription inside it. This action cannot be undone."), confirmLabel: t("Delete collection"), tone: "danger" })) return;
    try { await api(`/api/collections/${selected.id}`, { method: "DELETE" }); setSelectedId(null); await loadCollections(); notify(t("Collection deleted")); }
    catch (error) { notify(errorMessage(error), "bad"); }
  }
  async function changeSize(pageSize: number) {
    setSavingSize(true);
    try {
      const result = await api<{ user: User }>("/api/settings/preferences", { method: "PUT", ...jsonBody({ pageSize }) });
      setPage(1); onUserChange(result.user);
    } catch (error) { notify(errorMessage(error), "bad"); } finally { setSavingSize(false); }
  }
  return <div className="workspace">
    <section className="subscription-pane">{selected ? <>
      <header className="pane-header"><div><p className="eyebrow">{t("Collection")}</p><h1>{selected.name}</h1></div><div className="header-actions"><button className="icon-button header-action" aria-label={t("Rename collection")} title={t("Rename collection")} onClick={() => void renameCollection()}><Icon name="edit" /></button><button className="icon-button icon-button--danger header-action" aria-label={t("Delete collection")} title={t("Delete collection")} onClick={() => void deleteCollection()}><Icon name="trash" /></button><button className="button button--primary" onClick={() => setCreateOpen(true)}><Icon name="plus" size={16} />{t("Add subscription")}</button>
        <MenuButton className="icon-button header-more" triggerLabel={t("Collection actions")} menuLabel={t("Collection actions")} items={[{ id: "rename", label: t("Rename collection"), icon: "edit", onSelect: () => void renameCollection() }, { id: "delete", label: t("Delete collection"), icon: "trash", tone: "danger", onSelect: () => void deleteCollection() }]}><Icon name="more" /></MenuButton></div></header>
      <div className="list-toolbar"><div className="filter-tabs">{(["all", "unread", "errors"] as const).map((name) => <button key={name} className={filter === name ? "active" : ""} onClick={() => setFilter(name)}>{t(capitalize(name))}</button>)}</div><label className="search-box"><Icon name="search" size={16} /><input aria-label={t("Filter this collection")} placeholder={t("Filter this collection")} value={search} onChange={(event) => setSearch(event.target.value)} /></label></div>
      {user.paginationEnabled && <nav className="pagination" aria-label={t("Pagination")}>
        <label className="pagination-size-picker"><span>{t("Entries per page")}</span><select value={user.pageSize} disabled={savingSize} onChange={(event) => void changeSize(Number(event.target.value))}>{PAGE_SIZE_OPTIONS.map((size) => <option key={size} value={size}>{size}</option>)}</select></label>
        <PageNavigation page={page} pageCount={pageCount} total={total} loading={loading} onPageChange={setPage} />
      </nav>}
      <div className="subscription-head"><span>{t("Subscription")}</span><span>{t("Source")}</span><span>{t("Last check")}</span><span>{t("Status")}</span></div>
      <div className="subscription-list">{loading ? <ListSkeleton /> : subscriptions.map((item, index) => <SubscriptionRow key={item.id} item={item} index={index} onOpen={() => setSelectedSubscription(item.id)} />)}
        {!loading && subscriptions.length === 0 && <EmptyState icon="monitor" title={t(selected.subscriptionCount ? "Nothing matches this view" : "No subscriptions yet")} text={t(selected.subscriptionCount ? "Try a different status filter or search." : "Add a direct tracker link or a rule to begin monitoring.")} action={!selected.subscriptionCount ? <button className="button button--primary" onClick={() => setCreateOpen(true)}>{t("Add subscription")}</button> : undefined} />}
      </div>
      {user.paginationEnabled && <nav className="pagination pagination--bottom" aria-label={t("Bottom pagination")}>
        <PageNavigation page={page} pageCount={pageCount} total={total} loading={loading} onPageChange={setPage} announce={false} />
      </nav>}
    </> : <EmptyState icon="folder" title={t("Create your first collection")} text={t("Collections keep each user’s subscriptions separate and organized.")} action={<button className="button button--primary" onClick={onNewCollection}>{t("New collection")}</button>} />}</section>
    {createOpen && selected && <CreateSubscription collection={selected} onClose={() => setCreateOpen(false)} onCreated={async () => { setCreateOpen(false); setPage(1); await refresh(); }} notify={notify} />}
    {selectedSubscription && <SubscriptionInspector key={selectedSubscription} id={selectedSubscription} collections={collections} onClose={() => setSelectedSubscription(null)} onChanged={refresh} notify={notify} />}
  </div>;
}
function SubscriptionRow({ item, index, onOpen }: { item: SubscriptionSummary; index: number; onOpen: () => void }) {
  const { t } = useI18n();
  return <div className={`subscription-row ${item.isUnread ? "subscription-row--unread" : ""}`} style={{ "--row-index": Math.min(index, 20) } as CSSProperties}><button type="button" className="subscription-open" onClick={onOpen}><span className="subscription-main"><span className={`type-icon type-icon--${item.type} ${item.isUnread ? "type-icon--unread" : ""}`} role="img" aria-label={`${t(item.isUnread ? "Unread" : "Read")} ${t(item.type)} ${t("Subscription")}`} title={t(item.isUnread ? "Unread — open to mark read" : "Read")}><Icon name={item.isUnread ? "bellAlert" : item.type === "direct" ? "link" : "rule"} size={17} /></span><span>{item.type === "rule" ? <PhraseDisplay phrases={item.requiredTerms} /> : <strong>{item.label === "Direct subscription" ? t(item.label) : item.label}</strong>}<small>{item.type === "rule" ? item.ignoredTerms.length ? t("Excludes {terms}", { terms: item.ignoredTerms.join(", ") }) : t("Matches every required phrase") : item.directUrl}</small></span></span><span className="tracker-stack">{item.trackerKeys.map((key) => <TrackerTag key={key} tracker={key} />)}</span><span className="time-cell">{item.lastCheckedAt ? relativeTime(item.lastCheckedAt) : t("Pending")}</span><span className="row-status">{item.lastError ? <span className="state state--error">{t("Needs attention")}</span> : !item.enabled ? <span className="state">{t("Paused")}</span> : !item.initialized ? <span className="state state--pending">{t("Learning")}</span> : <span className="state state--good">{t("Watching")}</span>}</span></button></div>;
}
function CreateSubscription({ collection, onClose, onCreated, notify }: { collection: Collection; onClose: () => void; onCreated: () => Promise<void>; notify: Notify }) {
  const { t } = useI18n();
  const [type, setType] = useState<"direct" | "rule">("direct"), [url, setUrl] = useState("");
  const [required, setRequired] = useState<string[]>([]), [ignored, setIgnored] = useState<string[]>([...DEFAULT_IGNORED_PHRASES]);
  const [selectedTrackers, setSelectedTrackers] = useState<TrackerKey[]>(["kinozal", "rutor", "rutracker"]), [trackers, setTrackers] = useState<Tracker[]>([]), [busy, setBusy] = useState(false);
  useEffect(() => { const controller = new AbortController(); api<{ trackers: Tracker[] }>("/api/trackers", { signal: controller.signal }).then((result) => { if (!controller.signal.aborted) setTrackers(result.trackers); }).catch((error) => { if (!controller.signal.aborted) notify(errorMessage(error), "bad"); }); return () => controller.abort(); }, [notify]);
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true);
    const payload = type === "direct" ? { type, collectionId: collection.id, url } : { type, collectionId: collection.id, trackerKeys: selectedTrackers, requiredTerms: required, ignoredTerms: ignored };
    try { await api("/api/subscriptions", { method: "POST", ...jsonBody(payload) }); await onCreated(); notify(t(type === "direct" ? "Direct subscription added" : "Rule added and baseline scan started")); }
    catch (error) { notify(errorMessage(error), "bad"); } finally { setBusy(false); }
  }
  return <Drawer title={t("Add subscription")} subtitle={t("New monitor in {name}", { name: collection.name })} onClose={onClose} wide><div className="segmented"><button className={type === "direct" ? "active" : ""} onClick={() => setType("direct")} type="button"><Icon name="link" />{t("Direct link")}</button><button className={type === "rule" ? "active" : ""} onClick={() => setType("rule")} type="button"><Icon name="rule" />{t("Rule")}</button></div><form onSubmit={submit}>{type === "direct" ? <>
    <Field label={t("Tracker page URL")} hint={t("Kinozal, Rutor, or RuTracker")}><input type="url" placeholder="https://…" value={url} onChange={(event) => setUrl(event.target.value)} autoFocus required /></Field><InfoLine icon="clock">{t("The initial check creates a baseline. Later title, magnet, torrent-file, and metadata changes create events.")}</InfoLine>
  </> : <>
    <Field label={t("Trackers")}><div className="tracker-picker">{trackers.map((tracker) => <label key={tracker.key} className={selectedTrackers.includes(tracker.key) ? "tracker-choice tracker-choice--active" : "tracker-choice"}><input type="checkbox" checked={selectedTrackers.includes(tracker.key)} onChange={() => setSelectedTrackers((current) => current.includes(tracker.key) ? current.filter((key) => key !== tracker.key) : [...current, tracker.key])} /><TrackerTag tracker={tracker.key} /><span>{tracker.displayName}</span>{!tracker.credentialsConfigured && tracker.key !== "rutor" && <small>{t(tracker.key === "rutracker" ? "gap recovery unavailable" : "credentials missing")}</small>}</label>)}</div></Field>
    <Field label={t("Required phrases")} hint={t("Press Enter after each phrase. Every phrase must appear.")}><PhraseInput ariaLabel={t("Required phrases")} value={required} onChange={setRequired} placeholder={t("Type a phrase and press Enter")} /></Field>
    <Field label={t("Ignored phrases")} hint={t("Press Enter after each phrase. Any match is rejected.")}><PhraseInput ariaLabel={t("Ignored phrases")} value={ignored} onChange={setIgnored} placeholder={t("Type a phrase and press Enter")} /></Field>
    <InfoLine icon="monitor">{t("The first successful poll is a silent baseline. Only releases discovered afterward produce events.")}</InfoLine>
  </>}<DrawerActions onCancel={onClose} busy={busy} label={t(type === "direct" ? "Add direct link" : "Create rule")} disabled={type === "rule" && (!selectedTrackers.length || !required.length)} /></form></Drawer>;
}
