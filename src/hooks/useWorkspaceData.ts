import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "../api";
import type { Collection, Notify, SubscriptionSummary } from "../types";
import { errorMessage } from "../format";
import { DEFAULT_MONITOR_VIEW, type MonitorFilter, type MonitorSort, type MonitorView } from "../routing";

// With routing the view (collection, filter, search, page, sort) comes from the URL and changes are
// reported back; without it the hook keeps the view in local state.
export interface WorkspaceRouting {
  view: MonitorView;
  onViewChange: (view: MonitorView, options?: { replace?: boolean }) => void;
  preferredCollectionIds?: Array<string | null | undefined>;
}

export function useWorkspaceData(notify: Notify, paginationEnabled = false, pageSize = 50, active = true, routing?: WorkspaceRouting) {
  const [collections, setCollections] = useState<Collection[]>([]);
  const [collectionsLoaded, setCollectionsLoaded] = useState(false);
  const [localView, setLocalView] = useState<MonitorView>(DEFAULT_MONITOR_VIEW);
  const [subscriptions, setSubscriptions] = useState<SubscriptionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [total, setTotal] = useState(0);
  const [pageCount, setPageCount] = useState(1);
  const requested = routing?.view ?? localView;
  // Unknown or deleted collections fall back to the preferred ids, then the first collection.
  const known = (id: string | null | undefined): id is string => Boolean(id) && collections.some((collection) => collection.id === id);
  const view: MonitorView = !collectionsLoaded || known(requested.collectionId) ? requested
    : { ...requested, page: 1, collectionId: routing?.preferredCollectionIds?.find(known) ?? collections[0]?.id ?? null };
  const { collectionId: selectedId, filter, search, page, sort } = view;
  const selected = useRef<string | null>(null);
  const latest = useRef({ view, routing });
  const collectionRequest = useRef<AbortController | null>(null);
  const subscriptionRequest = useRef<AbortController | null>(null);
  useLayoutEffect(() => { latest.current = { view, routing }; });

  const changeView = useCallback((change: Partial<MonitorView>, options?: { replace?: boolean }) => {
    const next = { ...latest.current.view, ...change };
    if (latest.current.routing) latest.current.routing.onViewChange(next, options); else setLocalView(next);
  }, []);
  const setSelectedId = useCallback((id: string | null) => {
    if (latest.current.view.collectionId !== id) changeView({ collectionId: id, page: 1 });
  }, [changeView]);
  // Clear the previous collection's rows before paint, then let the load effect fetch the new one.
  useLayoutEffect(() => {
    if (selected.current === selectedId) return;
    selected.current = selectedId;
    subscriptionRequest.current?.abort();
    setSubscriptions([]);
    setLoading(Boolean(selectedId));
  }, [selectedId]);

  const loadCollections = useCallback(async () => {
    collectionRequest.current?.abort();
    const controller = new AbortController();
    collectionRequest.current = controller;
    try {
      const result = await api<{ collections: Collection[] }>("/api/collections", { signal: controller.signal });
      if (controller.signal.aborted) return;
      setCollections(result.collections);
      setCollectionsLoaded(true);
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    }
  }, []);

  const loadSubscriptions = useCallback(async () => {
    subscriptionRequest.current?.abort();
    if (!active) return;
    const controller = new AbortController();
    subscriptionRequest.current = controller;
    const id = selectedId;
    if (!id) {
      setSubscriptions([]);
      setLoading(false);
      return;
    }
    try {
      const query = new URLSearchParams({ collectionId: id, view: "summary", filter, search });
      if (sort !== "changed") query.set("sort", sort);
      if (paginationEnabled) { query.set("page", String(page)); query.set("pageSize", String(pageSize)); }
      const result = await api<{ subscriptions: SubscriptionSummary[]; total: number; page: number; pageCount: number }>(
        `/api/subscriptions?${query}`, { signal: controller.signal },
      );
      if (!controller.signal.aborted && selected.current === id) {
        setSubscriptions(result.subscriptions);
        setTotal(result.total ?? result.subscriptions.length);
        setPageCount(result.pageCount ?? 1);
        // The server clamps pages past the end (e.g. after deletions or a stale link).
        if (result.page !== undefined && result.page !== page) changeView({ page: result.page }, { replace: true });
      }
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    } finally {
      if (!controller.signal.aborted && selected.current === id) setLoading(false);
    }
  }, [selectedId, page, pageSize, paginationEnabled, filter, search, sort, active, changeView]);

  const refresh = useCallback(async () => {
    try {
      await Promise.all([loadCollections(), loadSubscriptions()]);
    } catch (error) {
      notify(errorMessage(error), "bad");
    }
  }, [loadCollections, loadSubscriptions, notify]);

  useEffect(() => {
    void loadCollections().catch((error) => notify(errorMessage(error), "bad"));
    return () => { collectionRequest.current?.abort(); subscriptionRequest.current?.abort(); };
  }, [loadCollections, notify]);
  useEffect(() => {
    setLoading(Boolean(selected.current));
    void loadSubscriptions().catch((error) => notify(errorMessage(error), "bad"));
    return () => subscriptionRequest.current?.abort();
  }, [loadSubscriptions, notify]);
  useEffect(() => {
    const timer = window.setInterval(() => void refresh(), 30_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const setPage = (value: number) => { if (value !== page) changeView({ page: value }); };
  const setFilter = (value: MonitorFilter) => { if (value !== filter) changeView({ filter: value, page: 1 }); };
  // Typing replaces the current history entry instead of adding one per search.
  const setSearch = (value: string) => { if (value !== search) changeView({ search: value, page: 1 }, { replace: true }); };
  const setSort = (value: MonitorSort) => { if (value !== sort) changeView({ sort: value, page: 1 }); };
  return { collections, collectionsLoaded, selectedId, setSelectedId, subscriptions, loading, loadCollections, refresh, view,
    page, setPage, filter, setFilter, search, setSearch, sort, setSort, total, pageCount };
}

export type WorkspaceData = ReturnType<typeof useWorkspaceData>;
