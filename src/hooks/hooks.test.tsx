// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import type { Collection, SubscriptionSummary } from "../types";
import { useWorkspaceData } from "./useWorkspaceData";
import { useSchedulerStatus } from "./useSchedulerStatus";

vi.mock("../api", () => ({ api: vi.fn() }));
const request = vi.mocked(api);
let root: Root;
let container: HTMLDivElement;
let workspace: ReturnType<typeof useWorkspaceData>;
let scheduler: ReturnType<typeof useSchedulerStatus>;
const notify = vi.fn();
const collections = ["one", "two"].map((id) => ({ id, name: id, subscriptionCount: 1, unreadCount: 0 }) as Collection);
const subscription = (id: string) => ({ id, label: id }) as SubscriptionSummary;
const statusResponse = { scheduler: { running: false, checked: 0, changed: 0, errors: 0 }, intervalMinutes: 30 };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function WorkspaceHarness() { workspace = useWorkspaceData(notify); return <span>{workspace.subscriptions.map((item) => item.label).join(",")}</span>; }
function SchedulerHarness({ path = "/" }: { path?: string }) { scheduler = useSchedulerStatus(path); return <span>{scheduler.checking ? "checking" : "idle"}</span>; }

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers();
  request.mockReset();
  notify.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe("workspace request lifecycle", () => {
  it("ignores late responses after switching collections, even when fetch ignores abort", async () => {
    const one = deferred<{ subscriptions: SubscriptionSummary[] }>();
    const two = deferred<{ subscriptions: SubscriptionSummary[] }>();
    request.mockImplementation(async (path) => path === "/api/collections" ? { collections }
      : path.includes("collectionId=one") ? one.promise : two.promise);
    await act(async () => root.render(<WorkspaceHarness />));
    expect(workspace.selectedId).toBe("one");
    await act(async () => workspace.setSelectedId("two"));
    expect(workspace.loading).toBe(true);
    await act(async () => two.resolve({ subscriptions: [subscription("two-result")] }));
    await act(async () => one.resolve({ subscriptions: [subscription("stale-one")] }));
    expect(container.textContent).toBe("two-result");
    expect(workspace.loading).toBe(false);
    expect(notify).not.toHaveBeenCalled();
    const first = request.mock.calls.find(([path]) => path.includes("collectionId=one"))!;
    expect(first[1]?.signal?.aborted).toBe(true);
    expect(first[0]).toContain("view=summary");
  });

  it("keeps the latest refresh and suppresses errors from superseded requests", async () => {
    request.mockImplementation(async (path) => path === "/api/collections" ? { collections } : { subscriptions: [subscription("initial")] });
    await act(async () => root.render(<WorkspaceHarness />));
    const old = deferred<{ subscriptions: SubscriptionSummary[] }>();
    const latest = deferred<{ subscriptions: SubscriptionSummary[] }>();
    let count = 0;
    request.mockImplementation(async (path) => path === "/api/collections" ? { collections } : ++count === 1 ? old.promise : latest.promise);
    let oldRefresh!: Promise<void>;
    let latestRefresh!: Promise<void>;
    await act(async () => { oldRefresh = workspace.refresh(); latestRefresh = workspace.refresh(); });
    await act(async () => { latest.resolve({ subscriptions: [subscription("latest")] }); await latestRefresh; });
    await act(async () => { old.reject(new Error("outdated failure")); await oldRefresh; });
    expect(container.textContent).toBe("latest");
    expect(notify).not.toHaveBeenCalled();
  });

  it("clears old rows immediately and reports a current request failure", async () => {
    request.mockImplementation(async (path) => path === "/api/collections" ? { collections } : { subscriptions: [subscription("one-result")] });
    await act(async () => root.render(<WorkspaceHarness />));
    request.mockRejectedValue(new Error("current failure"));
    await act(async () => workspace.setSelectedId("two"));
    expect(container.textContent).toBe("");
    expect(workspace.loading).toBe(false);
    expect(notify).toHaveBeenCalledWith("current failure", "bad");
  });

  it("aborts requests and clears timers on unmount, including StrictMode cleanup", async () => {
    const result = deferred<{ collections: Collection[] }>();
    request.mockImplementation(() => result.promise);
    await act(async () => root.render(<StrictMode><WorkspaceHarness /></StrictMode>));
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0][1]?.signal?.aborted).toBe(true);
    await act(async () => root.unmount());
    expect(request.mock.calls[1][1]?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => result.reject(new Error("unmounted")));
    expect(notify).not.toHaveBeenCalled();
  });
});

describe("adaptive scheduler status polling", () => {
  it("uses one timer, changes cadence for checks, and resets after a rejected check", async () => {
    request.mockResolvedValue(statusResponse);
    await act(async () => root.render(<SchedulerHarness />));
    expect(request).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
    await act(async () => vi.advanceTimersByTime(30_000));
    expect(request).toHaveBeenCalledTimes(2);
    const check = deferred<void>();
    let tracked!: Promise<void>;
    await act(async () => { tracked = scheduler.trackCheck(check.promise); void tracked.catch(() => undefined); });
    expect(scheduler.checking).toBe(true);
    expect(vi.getTimerCount()).toBe(1);
    await act(async () => vi.advanceTimersByTime(2_500));
    expect(request).toHaveBeenCalledTimes(3);
    await act(async () => { check.reject(new Error("check failed")); await tracked.catch(() => undefined); });
    expect(scheduler.checking).toBe(false);
    expect(vi.getTimerCount()).toBe(1);
    const calls = request.mock.calls.length;
    await act(async () => vi.advanceTimersByTime(2_500));
    expect(request).toHaveBeenCalledTimes(calls);
  });

  it("coalesces overlapping refreshes and aborts on unmount", async () => {
    const response = deferred<typeof statusResponse>();
    request.mockImplementation(() => response.promise);
    await act(async () => root.render(<SchedulerHarness />));
    await act(async () => vi.advanceTimersByTime(90_000));
    await act(async () => root.render(<SchedulerHarness path="/settings" />));
    expect(request).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
    expect(request.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => response.resolve(statusResponse));
  });

  it("starts a fresh request after StrictMode's simulated unmount", async () => {
    request.mockResolvedValue(statusResponse);
    await act(async () => root.render(<StrictMode><SchedulerHarness /></StrictMode>));
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(scheduler.intervalMinutes).toBe(30);
    expect(vi.getTimerCount()).toBe(1);
  });
});
