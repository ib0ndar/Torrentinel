import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { SchedulerStatus } from "../types";

export type TrackCheck = <T>(work: Promise<T>) => Promise<T>;
type StatusResponse = { scheduler: SchedulerStatus; intervalMinutes: number };
const ACTIVE_REFRESH_MS = 2_500;
const IDLE_REFRESH_MS = 30_000;
const MAX_SCHEDULED_DELAY_MS = 6 * 60 * 60_000;

export function useSchedulerStatus(path: string) {
  const [status, setStatus] = useState<SchedulerStatus | null>(null);
  const [intervalMinutes, setIntervalMinutes] = useState<number | null>(null);
  const [pendingChecks, setPendingChecks] = useState(0);
  const mounted = useRef(false);
  const inFlight = useRef<{ controller: AbortController; work: Promise<void> } | null>(null);
  const checking = Boolean(status?.running) || pendingChecks > 0;
  const upcomingRunAt = status?.running ? undefined : status?.nextRunAt;

  const loadStatus = useCallback((): Promise<void> => {
    if (!mounted.current) return Promise.resolve();
    if (inFlight.current) return inFlight.current.work;
    const controller = new AbortController();
    const work = api<StatusResponse>("/api/system/status", { signal: controller.signal })
      .then((result) => {
        if (mounted.current && !controller.signal.aborted) {
          setStatus(result.scheduler);
          setIntervalMinutes(result.intervalMinutes);
        }
      }).catch(() => undefined).finally(() => {
        if (inFlight.current?.controller === controller) inFlight.current = null;
      });
    inFlight.current = { controller, work };
    return work;
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      inFlight.current?.controller.abort();
      inFlight.current = null;
    };
  }, []);
  useEffect(() => { void loadStatus(); }, [loadStatus, path]);
  useEffect(() => {
    const timer = window.setInterval(() => void loadStatus(), checking ? ACTIVE_REFRESH_MS : IDLE_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [checking, loadStatus]);
  useEffect(() => {
    if (!upcomingRunAt) return;
    const delay = Date.parse(upcomingRunAt) - Date.now() + 1_500;
    if (!(delay > 0 && delay <= MAX_SCHEDULED_DELAY_MS)) return;
    const timer = window.setTimeout(() => void loadStatus(), delay);
    return () => window.clearTimeout(timer);
  }, [upcomingRunAt, loadStatus]);

  const trackCheck = useCallback<TrackCheck>((work) => {
    setPendingChecks((count) => count + 1);
    return work.finally(() => {
      if (mounted.current) {
        setPendingChecks((count) => count - 1);
        void loadStatus();
      }
    });
  }, [loadStatus]);

  return { status, intervalMinutes, checking, trackCheck };
}
