import { createContext, type ReactNode, useCallback, useContext, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { api } from "../api";
import type { Tracker, TrackerKey } from "../types";

export interface TrackerList {
  /** Trackers from GET /api/trackers (keys, display names, capabilities, the account's access); null until loaded. */
  trackers: Tracker[] | null;
  /** Loads the list unless it is loaded or loading; rejects when loading fails, so a later call tries again. */
  ensure: () => Promise<Tracker[]>;
  /** Loads the list again, e.g. after tracker access or global mirrors change. */
  reload: () => Promise<Tracker[]>;
}

const TrackersContext = createContext<TrackerList | null>(null);

function useTrackerStore(): TrackerList {
  const [trackers, setTrackers] = useState<Tracker[] | null>(null);
  const loaded = useRef<Tracker[] | null>(null), pending = useRef<Promise<Tracker[]> | null>(null), latest = useRef(0);
  const reload = useCallback(() => {
    const sequence = ++latest.current;
    const request = api<{ trackers?: Tracker[] }>("/api/trackers").then((result) => {
      const list = result.trackers ?? [];
      // An older request finishing late never replaces a newer list.
      if (sequence === latest.current) { loaded.current = list; setTrackers(list); }
      return loaded.current ?? list;
    }).finally(() => { if (pending.current === request) pending.current = null; });
    pending.current = request;
    return request;
  }, []);
  const ensure = useCallback(() => loaded.current ? Promise.resolve(loaded.current) : pending.current ?? reload(), [reload]);
  return useMemo(() => ({ trackers, ensure, reload }), [trackers, ensure, reload]);
}

// One list per signed-in session: loaded once when the shell opens and shared by every page.
export function TrackersProvider({ children }: { children: ReactNode }) {
  const store = useTrackerStore(), { ensure } = store;
  // Failures are reported by the views that need the list, which also retry.
  useEffect(() => { ensure().catch(() => undefined); }, [ensure]);
  return <TrackersContext.Provider value={store}>{children}</TrackersContext.Provider>;
}

// The shared list; outside a provider (isolated views) the component loads its own copy.
export function useTrackers(onError?: (error: unknown) => void): TrackerList {
  const shared = useContext(TrackersContext), local = useTrackerStore(), store = shared ?? local, { ensure } = store;
  const fail = useEffectEvent((error: unknown) => onError?.(error));
  useEffect(() => {
    let active = true;
    ensure().catch((error) => { if (active) fail(error); });
    return () => { active = false; };
  }, [ensure]);
  return store;
}

// Display names for markers; never starts a request. Falls back to the key until the list is loaded.
export function useTrackerName(): (key: TrackerKey) => string {
  const trackers = useContext(TrackersContext)?.trackers;
  return useCallback((key: TrackerKey) => trackers?.find((tracker) => tracker.key === key)?.displayName ?? key, [trackers]);
}
