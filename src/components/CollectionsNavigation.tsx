import { type FormEvent, useEffect, useRef, useState } from "react";
import { api, jsonBody } from "../api";
import { capitalize, errorMessage } from "../format";
import { useI18n } from "../i18n";
import { collectionDefaultFilter, isPlainClick, MONITOR_FILTERS } from "../routing";
import type { Collection, Notify } from "../types";
import { Icon } from "./Icon";
import { Drawer, DrawerActions, EmptyCompact, Field } from "./UI";

export function CollectionsNavigation({ collections, selectedId, hrefFor, onSelect, onCreate, className, id }: {
  collections: Collection[];
  selectedId: string | null;
  hrefFor: (id: string) => string;
  onSelect: (id: string) => void;
  onCreate: () => void;
  className: string;
  id?: string;
}) {
  const { t } = useI18n();
  const listRef = useRef<HTMLDivElement>(null);
  // The mobile strip scrolls horizontally: keep the selected collection fully visible
  // by adjusting only the strip, never the page.
  useEffect(() => {
    const list = listRef.current, active = list?.querySelector<HTMLElement>(".collection-item--active");
    if (!list || !active || list.scrollWidth <= list.clientWidth) return;
    const bounds = list.getBoundingClientRect(), item = active.getBoundingClientRect(), inset = 16;
    if (item.left < bounds.left + inset) list.scrollLeft -= bounds.left + inset - item.left;
    else if (item.right > bounds.right - inset) list.scrollLeft += item.right - (bounds.right - inset);
  }, [selectedId, collections]);
  return <section id={id} className={`collection-rail ${className}`} aria-label={t("Collections")}>
    <div className="rail-heading"><span>{t("Collections")}</span><button className="icon-button" aria-label={t("New collection")} title={t("New collection")} onClick={onCreate}><Icon name="plus" /></button></div>
    <div ref={listRef} className="collection-list">{collections.map((collection) => <a key={collection.id} href={hrefFor(collection.id)} className={`collection-item ${selectedId === collection.id ? "collection-item--active" : ""}`} aria-current={selectedId === collection.id ? "page" : undefined} onClick={(event) => { if (!isPlainClick(event)) return; event.preventDefault(); onSelect(collection.id); }}><span className="collection-glyph">{collection.name.slice(0, 1).toUpperCase()}</span><span className="collection-copy"><strong>{collection.name}</strong><small>{t("{count} subscriptions", { count: collection.subscriptionCount })}</small></span>{collection.unreadCount > 0 && <span className="count-badge">{collection.unreadCount}</span>}</a>)}</div>
    {collections.length === 0 && <EmptyCompact text={t("Create a collection to start monitoring.")} />}
  </section>;
}

export function CollectionEditor({ collection, onClose, onSaved, notify }: { collection?: Collection; onClose: () => void; onSaved: (collection: Collection) => Promise<void>; notify: Notify }) {
  const { t } = useI18n();
  const [name, setName] = useState(collection?.name ?? ""), [defaultFilter, setDefaultFilter] = useState(collectionDefaultFilter(collection)), [busy, setBusy] = useState(false);
  const changes = collection ? { ...name.trim() !== collection.name ? { name: name.trim() } : {}, ...defaultFilter !== collectionDefaultFilter(collection) ? { defaultFilter } : {} } : {};
  const unchanged = Boolean(collection) && Object.keys(changes).length === 0;
  async function submit(event: FormEvent) {
    event.preventDefault(); if (unchanged) return; setBusy(true);
    try {
      if (collection) { await api(`/api/collections/${collection.id}`, { method: "PATCH", ...jsonBody(changes) }); await onSaved({ ...collection, ...changes }); notify(t("Collection updated")); }
      else { const result = await api<{ collection: Collection }>("/api/collections", { method: "POST", ...jsonBody({ name: name.trim(), defaultFilter }) }); await onSaved(result.collection); notify(t("Collection created")); }
    } catch (error) { notify(errorMessage(error), "bad"); } finally { setBusy(false); }
  }
  return <Drawer title={t(collection ? "Edit collection" : "New collection")} subtitle={t(collection ? "Rename the collection or choose the view it opens with." : "Create an isolated place for related subscriptions.")} onClose={onClose}><form onSubmit={submit}>
    <Field label={t("Collection name")}><input value={name} onChange={(event) => setName(event.target.value)} maxLength={80} autoFocus required /></Field>
    <fieldset className="choice-field">
      <legend>{t("Default view")}</legend>
      <div className="segmented segmented--three">{MONITOR_FILTERS.map((filter) => <label key={filter} className={defaultFilter === filter ? "active" : undefined}>
        <input type="radio" name="default-filter" value={filter} checked={defaultFilter === filter} onChange={() => setDefaultFilter(filter)} />{t(capitalize(filter))}
      </label>)}</div>
      <p className="choice-field__hint">{t("Opening this collection shows this view. You can switch filters at any time.")}</p>
    </fieldset>
    <DrawerActions onCancel={onClose} busy={busy} label={t(collection ? "Save changes" : "Create collection")} disabled={unchanged} />
  </form></Drawer>;
}
