import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { Collection, Notify, SubscriptionSummary } from "../types";
import { errorMessage } from "../format";

export function useWorkspaceData(notify: Notify, paginationEnabled = false, pageSize = 50) {
  const [collections, setCollections] = useState<Collection[]>([]);
  const [selectedId, setSelection] = useState<string | null>(null);
  const [subscriptions, setSubscriptions] = useState<SubscriptionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState<"all" | "unread" | "errors">("all");
  const [search, setSearch] = useState("");
  const [total, setTotal] = useState(0);
  const [pageCount, setPageCount] = useState(1);
  const selected = useRef<string | null>(null);
  const collectionRequest = useRef<AbortController | null>(null);
  const subscriptionRequest = useRef<AbortController | null>(null);

  const setSelectedId = useCallback((id: string | null) => {
    if (selected.current === id) return;
    selected.current = id;
    subscriptionRequest.current?.abort();
    setSelection(id);
    setPage(1);
    setSubscriptions([]);
    setLoading(Boolean(id));
  }, []);

  const loadCollections = useCallback(async () => {
    collectionRequest.current?.abort();
    const controller = new AbortController();
    collectionRequest.current = controller;
    try {
      const result = await api<{ collections: Collection[] }>("/api/collections", { signal: controller.signal });
      if (controller.signal.aborted) return;
      setCollections(result.collections);
      const current = selected.current;
      setSelectedId(current && result.collections.some((item) => item.id === current) ? current : result.collections[0]?.id || null);
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    }
  }, [setSelectedId]);

  const loadSubscriptions = useCallback(async () => {
    subscriptionRequest.current?.abort();
    const controller = new AbortController();
    subscriptionRequest.current = controller;
    const id = selected.current;
    if (!id) {
      setSubscriptions([]);
      setLoading(false);
      return;
    }
    try {
      const query = new URLSearchParams({ collectionId: id, view: "summary", filter, search });
      if (paginationEnabled) { query.set("page", String(page)); query.set("pageSize", String(pageSize)); }
      const result = await api<{ subscriptions: SubscriptionSummary[]; total: number; page: number; pageCount: number }>(
        `/api/subscriptions?${query}`, { signal: controller.signal },
      );
      if (!controller.signal.aborted && selected.current === id) {
        setSubscriptions(result.subscriptions);
        setTotal(result.total ?? result.subscriptions.length);
        setPageCount(result.pageCount ?? 1);
        if (result.page !== undefined) setPage(result.page);
      }
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    } finally {
      if (!controller.signal.aborted && selected.current === id) setLoading(false);
    }
  }, [page, pageSize, paginationEnabled, filter, search]);

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
  }, [selectedId, loadSubscriptions, notify]);
  useEffect(() => {
    const timer = window.setInterval(() => void refresh(), 30_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  function changePage(value: number) { if (value === page) return; subscriptionRequest.current?.abort(); setPage(value); }
  function changeFilter(value: typeof filter) { if (value === filter) return; subscriptionRequest.current?.abort(); setPage(1); setFilter(value); }
  function changeSearch(value: string) { if (value === search) return; subscriptionRequest.current?.abort(); setPage(1); setSearch(value); }
  return { collections, selectedId, setSelectedId, subscriptions, loading, loadCollections, refresh,
    page, setPage: changePage, filter, setFilter: changeFilter, search, setSearch: changeSearch, total, pageCount };
}
