import { type FormEvent, useEffect, useRef, useState } from "react";
import { api, jsonBody } from "../api";
import { errorMessage } from "../format";
import { useI18n } from "../i18n";
import type { Collection, Notify } from "../types";
import { Icon } from "./Icon";
import { Drawer, DrawerActions, EmptyCompact, Field } from "./UI";

export function CollectionsNavigation({ collections, selectedId, onSelect, onCreate, className, id }: {
  collections: Collection[];
  selectedId: string | null;
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
    <div ref={listRef} className="collection-list">{collections.map((collection) => <button key={collection.id} className={`collection-item ${selectedId === collection.id ? "collection-item--active" : ""}`} aria-current={selectedId === collection.id ? "page" : undefined} onClick={() => onSelect(collection.id)}><span className="collection-glyph">{collection.name.slice(0, 1).toUpperCase()}</span><span className="collection-copy"><strong>{collection.name}</strong><small>{t("{count} subscriptions", { count: collection.subscriptionCount })}</small></span>{collection.unreadCount > 0 && <span className="count-badge">{collection.unreadCount}</span>}</button>)}</div>
    {collections.length === 0 && <EmptyCompact text={t("Create a collection to start monitoring.")} />}
  </section>;
}

export function NewCollection({ onClose, onCreated, notify }: { onClose: () => void; onCreated: (id: string) => Promise<void>; notify: Notify }) {
  const { t } = useI18n();
  const [name, setName] = useState(""), [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true);
    try { const result = await api<{ collection: Collection }>("/api/collections", { method: "POST", ...jsonBody({ name }) }); await onCreated(result.collection.id); notify(t("Collection created")); }
    catch (error) { notify(errorMessage(error), "bad"); } finally { setBusy(false); }
  }
  return <Drawer title={t("New collection")} subtitle={t("Create an isolated place for related subscriptions.")} onClose={onClose}><form onSubmit={submit}><Field label={t("Collection name")}><input value={name} onChange={(event) => setName(event.target.value)} maxLength={80} autoFocus required /></Field><DrawerActions onCancel={onClose} busy={busy} label={t("Create collection")} /></form></Drawer>;
}
