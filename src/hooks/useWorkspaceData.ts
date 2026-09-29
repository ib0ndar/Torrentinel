import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { Collection, Notify, SubscriptionSummary } from "../types";

export function useWorkspaceData(notify: Notify) {
  const [collections, setCollections] = useState<Collection[]>([]);
  const [selectedId, setSelection] = useState<string | null>(null);
  const [subscriptions, setSubscriptions] = useState<SubscriptionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const selected = useRef<string | null>(null);
  const collectionRequest = useRef<AbortController | null>(null);
  const subscriptionRequest = useRef<AbortController | null>(null);

  const setSelectedId = useCallback((id: string | null) => {
    if (selected.current === id) return;
    selected.current = id;
    subscriptionRequest.current?.abort();
    setSelection(id);
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
      const result = await api<{ subscriptions: SubscriptionSummary[] }>(
        `/api/subscriptions?collectionId=${encodeURIComponent(id)}&view=summary`, { signal: controller.signal },
      );
      if (!controller.signal.aborted && selected.current === id) setSubscriptions(result.subscriptions);
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    } finally {
      if (!controller.signal.aborted && selected.current === id) setLoading(false);
    }
  }, []);

  const refresh = useCallback(async () => {
    try {
      await Promise.all([loadCollections(), loadSubscriptions()]);
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), "bad");
    }
  }, [loadCollections, loadSubscriptions, notify]);

  useEffect(() => {
    void loadCollections().catch((error) => notify(error instanceof Error ? error.message : String(error), "bad"));
    return () => { collectionRequest.current?.abort(); subscriptionRequest.current?.abort(); };
  }, [loadCollections, notify]);
  useEffect(() => {
    void loadSubscriptions().catch((error) => notify(error instanceof Error ? error.message : String(error), "bad"));
    return () => subscriptionRequest.current?.abort();
  }, [selectedId, loadSubscriptions, notify]);
  useEffect(() => {
    const timer = window.setInterval(() => void refresh(), 30_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  return { collections, selectedId, setSelectedId, subscriptions, loading, loadCollections, refresh };
}
