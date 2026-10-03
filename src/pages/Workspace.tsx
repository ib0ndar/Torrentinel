import { type CSSProperties, type FormEvent, useEffect, useRef, useState } from "react";
import { api, jsonBody } from "../api";
import { moveRowFocus, useKeyboardShortcuts } from "../hooks/useKeyboardShortcuts";
import { useTrackers } from "../hooks/useTrackers";
import type { WorkspaceData } from "../hooks/useWorkspaceData";
import { useDialog } from "../components/Dialogs";
import { Icon } from "../components/Icon";
import { MenuButton, type MenuItem } from "../components/Menu";
import { Drawer, DrawerActions, EmptyState, Field, FilterTabs, InfoLine, ListSkeleton, PhraseDisplay, PhraseInput, SubscriptionTypeIcon, TrackerTag } from "../components/UI";
import { capitalize, errorMessage, relativeTime } from "../format";
import { useI18n } from "../i18n";
import { MONITOR_FILTERS, type MonitorFilter, MONITOR_SORTS, type MonitorSort } from "../routing";
import { SubscriptionInspector } from "./SubscriptionInspector";
import type { Collection, Notify, SubscriptionSummary, TrackerKey, User } from "../types";
import { PAGE_SIZE_OPTIONS } from "../types";
import { PageNavigation } from "../components/Pagination";

const DEFAULT_IGNORED_PHRASES = ["Trailer", "Трейлер", "Teaser", "Тизер", "Soundtrack", "Саундтрек"];
const SORT_LABELS: Record<MonitorSort, string> = { changed: "Last change", name: "Name (A–Z)", attention: "Needs attention first" };
const FILTER_COUNTS: Record<MonitorFilter, (collection: Collection) => number> = { all: (collection) => collection.subscriptionCount, unread: (collection) => collection.unreadCount, errors: (collection) => collection.errorCount };
export function Workspace({ user, onUserChange, notify, data, onNewCollection, onShowShortcuts }: { user: User; onUserChange: (user: User) => void; notify: Notify; data: WorkspaceData; onNewCollection: () => void; onShowShortcuts?: () => void }) {
  const { t } = useI18n(), dialog = useDialog();
  const { collections, collectionsLoaded, selectedId, subscriptions, loading, loadCollections, refresh, filter, setFilter, sort, setSort, page, setPage, total, pageCount } = data;
  const [search, setSearch] = useState(data.search);
  const sentSearch = useRef(data.search);
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedSubscription, setSelectedSubscription] = useState<string | null>(null);
  const [savingSize, setSavingSize] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  // Debounce only typing, not collection/page navigation. Search always covers
  // the complete collection on the server, including off-page records.
  useEffect(() => {
    const timer = window.setTimeout(() => { sentSearch.current = search; data.setSearch(search); }, 250);
    return () => window.clearTimeout(timer);
  }, [search]);
  // Back/forward and collection links can change the search from outside the box.
  useEffect(() => { if (data.search !== sentSearch.current) { sentSearch.current = data.search; setSearch(data.search); } }, [data.search]);
  const selected = collections.find((collection) => collection.id === selectedId);
  useKeyboardShortcuts({ "?": onShowShortcuts, j: () => moveRowFocus(".subscription-open", 1), k: () => moveRowFocus(".subscription-open", -1),
    ...selected ? { "/": () => searchRef.current?.focus(), a: () => setCreateOpen(true) } : {} });
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
    // The view falls back to another collection once the deleted one is gone from the list.
    try { await api(`/api/collections/${selected.id}`, { method: "DELETE" }); await loadCollections(); notify(t("Collection deleted")); }
    catch (error) { notify(errorMessage(error), "bad"); }
  }
  async function markCollectionRead() {
    if (!selected?.unreadCount) return;
    const count = selected.unreadCount;
    if (!await dialog.confirm({ eyebrow: t("Mark all read"), title: t("Mark “{name}” as read?", { name: selected.name }),
      description: t(count === 1 ? "One unread subscription in this collection will be marked read. Reminders set with Mark unread are cleared too." : "{count} unread subscriptions in this collection will be marked read. Reminders set with Mark unread are cleared too.", { count }),
      confirmLabel: t("Mark all read") })) return;
    try { await api("/api/activity/read", { method: "POST", ...jsonBody({ collectionId: selected.id }) }); await refresh(); notify(t("Collection marked read")); }
    catch (error) { notify(errorMessage(error), "bad"); }
  }
  async function changeSize(pageSize: number) {
    setSavingSize(true);
    try {
      const result = await api<{ user: User }>("/api/settings/preferences", { method: "PUT", ...jsonBody({ pageSize }) });
      setPage(1); onUserChange(result.user);
    } catch (error) { notify(errorMessage(error), "bad"); } finally { setSavingSize(false); }
  }
  const unread = Boolean(selected?.unreadCount);
  const collectionActions: MenuItem[] = [...unread ? [{ id: "read", label: t("Mark all read"), icon: "check", onSelect: () => void markCollectionRead() } satisfies MenuItem] : [],
    { id: "rename", label: t("Rename collection"), icon: "edit", onSelect: () => void renameCollection() }, { id: "delete", label: t("Delete collection"), icon: "trash", tone: "danger", onSelect: () => void deleteCollection() }];
  // Navigation is only useful with more than one page; the page size stays reachable below the list.
  const paged = user.paginationEnabled && pageCount > 1;
  return <div className="workspace">
    <section className="subscription-pane">{selected ? <>
      <header className="pane-header"><div><p className="eyebrow">{t("Collection")}</p><h1>{selected.name}</h1></div><div className="header-actions">{unread && <button className="button button--quiet header-action header-read" onClick={() => void markCollectionRead()}><Icon name="check" size={16} />{t("Mark all read")}</button>}<button className="icon-button header-action" aria-label={t("Rename collection")} title={t("Rename collection")} onClick={() => void renameCollection()}><Icon name="edit" /></button><button className="icon-button icon-button--danger header-action" aria-label={t("Delete collection")} title={t("Delete collection")} onClick={() => void deleteCollection()}><Icon name="trash" /></button><button className="button button--primary" onClick={() => setCreateOpen(true)}><Icon name="plus" size={16} />{t("Add subscription")}</button>
        <MenuButton className="icon-button header-more" triggerLabel={t("Collection actions")} menuLabel={t("Collection actions")} items={collectionActions}><Icon name="more" /></MenuButton></div></header>
      <div className="list-toolbar"><FilterTabs label={t("Filter subscriptions")} options={MONITOR_FILTERS.map((name) => ({ value: name, label: t(capitalize(name)), count: FILTER_COUNTS[name](selected), alert: name === "errors" }))} value={filter} onChange={setFilter} />
        <div className="list-toolbar__controls"><label className="sort-picker" title={t("Sort")}><Icon name="sort" size={15} /><select aria-label={t("Sort")} value={sort} onChange={(event) => setSort(event.target.value as MonitorSort)}>{MONITOR_SORTS.map((value) => <option key={value} value={value}>{t(SORT_LABELS[value])}</option>)}</select></label>
          <label className="search-box"><Icon name="search" size={16} /><input ref={searchRef} aria-label={t("Filter this collection")} placeholder={t("Search")} value={search} onChange={(event) => setSearch(event.target.value)} /></label></div></div>
      {paged && <nav className="pagination pagination--top" aria-label={t("Pagination")}>
        <PageNavigation page={page} pageCount={pageCount} total={total} loading={loading} onPageChange={setPage} />
      </nav>}
      <div className="subscription-head"><span>{t("Subscription")}</span><span>{t("Source")}</span><span>{t("Last change")}</span><span>{t("Status")}</span></div>
      <div className="subscription-list">{loading ? <ListSkeleton /> : subscriptions.map((item, index) => <SubscriptionRow key={item.id} item={item} index={index} onOpen={() => setSelectedSubscription(item.id)} />)}
        {!loading && subscriptions.length === 0 && <EmptyState icon="monitor" title={t(selected.subscriptionCount ? "Nothing matches this view" : "No subscriptions yet")} text={t(selected.subscriptionCount ? "Try a different status filter or search." : "Add a direct tracker link or a rule to begin monitoring.")} action={!selected.subscriptionCount ? <button className="button button--primary" onClick={() => setCreateOpen(true)}>{t("Add subscription")}</button> : undefined} />}
      </div>
      {user.paginationEnabled && total > 0 && <nav className="pagination pagination--bottom" aria-label={t("Bottom pagination")}>
        <label className="pagination-size-picker"><span>{t("Entries per page")}</span><select value={user.pageSize} disabled={savingSize} onChange={(event) => void changeSize(Number(event.target.value))}>{PAGE_SIZE_OPTIONS.map((size) => <option key={size} value={size}>{size}</option>)}</select></label>
        {paged && <PageNavigation page={page} pageCount={pageCount} total={total} loading={loading} onPageChange={setPage} announce={false} />}
      </nav>}
    </> : !collectionsLoaded || collections.length ? <ListSkeleton /> : <EmptyState icon="folder" title={t("Create your first collection")} text={t("Collections keep each user’s subscriptions separate and organized.")} action={<button className="button button--primary" onClick={onNewCollection}>{t("New collection")}</button>} />}</section>
    {createOpen && selected && <CreateSubscription collection={selected} onClose={() => setCreateOpen(false)} onCreated={async () => { setCreateOpen(false); setPage(1); await refresh(); }} notify={notify} />}
    {selectedSubscription && <SubscriptionInspector key={selectedSubscription} id={selectedSubscription} collections={collections} onClose={() => setSelectedSubscription(null)} onChanged={refresh} notify={notify} />}
  </div>;
}
function SubscriptionRow({ item, index, onOpen }: { item: SubscriptionSummary; index: number; onOpen: () => void }) {
  const { t } = useI18n();
  const checked = item.lastCheckedAt ? t("Last checked {time}", { time: relativeTime(item.lastCheckedAt) }) : t("Waiting for first check");
  return <div className={`subscription-row ${item.isUnread ? "subscription-row--unread" : ""}`} style={{ "--row-index": Math.min(index, 20) } as CSSProperties}><button type="button" className="subscription-open" onClick={onOpen}><span className="subscription-main"><SubscriptionTypeIcon type={item.type} unread={item.isUnread} /><span>{item.type === "rule" ? <PhraseDisplay phrases={item.requiredTerms} /> : <strong>{item.label === "Direct subscription" ? t(item.label) : item.label}</strong>}<small>{item.type === "rule" ? item.ignoredTerms.length ? t("Excludes {terms}", { terms: item.ignoredTerms.join(", ") }) : t("Matches every required phrase") : item.directUrl}</small></span></span><span className="tracker-stack">{item.trackerKeys.map((key) => <TrackerTag key={key} tracker={key} />)}</span><span className="time-cell" title={checked}>{item.lastChangedAt ? relativeTime(item.lastChangedAt) : <span className="time-cell__none">{t("No changes yet")}</span>}</span><span className="row-status">{item.lastError ? <span className="state state--error">{t("Needs attention")}</span> : !item.enabled ? <span className="state">{t("Paused")}</span> : !item.initialized ? <span className="state state--pending">{t("Learning")}</span> : <span className="state state--good">{t("Watching")}</span>}</span></button></div>;
}
function CreateSubscription({ collection, onClose, onCreated, notify }: { collection: Collection; onClose: () => void; onCreated: () => Promise<void>; notify: Notify }) {
  const { t, language } = useI18n();
  const [type, setType] = useState<"direct" | "rule">("direct"), [url, setUrl] = useState("");
  const [required, setRequired] = useState<string[]>([]), [ignored, setIgnored] = useState<string[]>([...DEFAULT_IGNORED_PHRASES]);
  const [chosenTrackers, setChosenTrackers] = useState<TrackerKey[] | null>(null), [busy, setBusy] = useState(false);
  const { trackers } = useTrackers((error) => notify(errorMessage(error), "bad"));
  const ruleTrackers = trackers?.filter((tracker) => tracker.capabilities.rules) ?? [];
  // Every rule-capable tracker is selected until the choice is changed.
  const selectedTrackers = chosenTrackers ?? ruleTrackers.map((tracker) => tracker.key);
  const toggleTracker = (key: TrackerKey) => setChosenTrackers((current) => { const selection = current ?? ruleTrackers.map((tracker) => tracker.key); return selection.includes(key) ? selection.filter((item) => item !== key) : [...selection, key]; });
  const directSources = trackers ? new Intl.ListFormat(language, { type: "disjunction" }).format(trackers.filter((tracker) => tracker.capabilities.direct).map((tracker) => tracker.displayName)) : undefined;
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true);
    const payload = type === "direct" ? { type, collectionId: collection.id, url } : { type, collectionId: collection.id, trackerKeys: selectedTrackers, requiredTerms: required, ignoredTerms: ignored };
    try { await api("/api/subscriptions", { method: "POST", ...jsonBody(payload) }); await onCreated(); notify(t(type === "direct" ? "Direct subscription added" : "Rule added and baseline scan started")); }
    catch (error) { notify(errorMessage(error), "bad"); } finally { setBusy(false); }
  }
  return <Drawer title={t("Add subscription")} subtitle={t("New monitor in {name}", { name: collection.name })} onClose={onClose} wide><div className="segmented"><button className={type === "direct" ? "active" : ""} aria-pressed={type === "direct"} onClick={() => setType("direct")} type="button"><Icon name="link" />{t("Direct link")}</button><button className={type === "rule" ? "active" : ""} aria-pressed={type === "rule"} onClick={() => setType("rule")} type="button"><Icon name="rule" />{t("Rule")}</button></div><form onSubmit={submit}>{type === "direct" ? <>
    <Field label={t("Tracker page URL")} hint={directSources}><input type="url" placeholder="https://…" value={url} onChange={(event) => setUrl(event.target.value)} autoFocus required /></Field><InfoLine icon="clock">{t("The initial check creates a baseline. Later title, magnet, torrent-file, and metadata changes create events.")}</InfoLine>
  </> : <>
    <Field label={t("Trackers")}><div className="tracker-picker">{ruleTrackers.map((tracker) => <label key={tracker.key} className={selectedTrackers.includes(tracker.key) ? "tracker-choice tracker-choice--active" : "tracker-choice"}><input type="checkbox" checked={selectedTrackers.includes(tracker.key)} onChange={() => toggleTracker(tracker.key)} /><TrackerTag tracker={tracker.key} /><span>{tracker.displayName}</span>{!tracker.credentialsConfigured && tracker.capabilities.authentication !== "none" && <small>{t(tracker.capabilities.ruleDiscovery === "feed" ? "gap recovery unavailable" : "credentials missing")}</small>}</label>)}</div></Field>
    <Field label={t("Required phrases")} hint={t("Press Enter after each phrase. Every phrase must appear.")}><PhraseInput ariaLabel={t("Required phrases")} value={required} onChange={setRequired} placeholder={t("Type a phrase and press Enter")} /></Field>
    <Field label={t("Ignored phrases")} hint={t("Press Enter after each phrase. Any match is rejected.")}><PhraseInput ariaLabel={t("Ignored phrases")} value={ignored} onChange={setIgnored} placeholder={t("Type a phrase and press Enter")} /></Field>
    <InfoLine icon="monitor">{t("The first successful poll is a silent baseline. Only releases discovered afterward produce events.")}</InfoLine>
  </>}<DrawerActions onCancel={onClose} busy={busy} label={t(type === "direct" ? "Add direct link" : "Create rule")} disabled={type === "rule" && (!selectedTrackers.length || !required.length)} /></form></Drawer>;
}
