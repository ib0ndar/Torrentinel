// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import type { Collection, SubscriptionSummary } from "../types";
import { useWorkspaceData } from "./useWorkspaceData";
import { useSchedulerStatus } from "./useSchedulerStatus";
import { useVisibleInterval } from "./useVisibleInterval";

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
function PagedWorkspaceHarness({ enabled = true, size = 25 }: { enabled?: boolean; size?: number }) { workspace = useWorkspaceData(notify, enabled, size); return <span>{workspace.subscriptions.map((item) => item.label).join(",")}</span>; }
function SchedulerHarness({ path = "/" }: { path?: string }) { scheduler = useSchedulerStatus(path); return <span>{scheduler.checking ? "checking" : "idle"}</span>; }

let visibility: DocumentVisibilityState = "visible";
const setVisibility = (state: DocumentVisibilityState) => act(async () => { visibility = state; document.dispatchEvent(new Event("visibilitychange")); });
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
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
  it("opens the picked collection in its default filter, keeps the view when a default changes, and opens another collection in its own default", async () => {
    let defaults: Record<string, string> = { one: "unread", two: "errors" };
    const list = deferred<{ collections: Collection[] }>(), withDefaults = () => collections.map((collection) => ({ ...collection, defaultFilter: defaults[collection.id] }) as Collection);
    let first = true;
    request.mockImplementation(async (path) => {
      if (path === "/api/collections") { if (!first) return { collections: withDefaults() }; first = false; return list.promise; }
      return { subscriptions: [subscription(new URL(path, "http://test").searchParams.get("filter")!)] };
    });
    const filtersRequested = () => request.mock.calls.filter(([path]) => path.startsWith("/api/subscriptions?")).map(([path]) => new URL(path, "http://test").searchParams.get("filter"));
    await act(async () => root.render(<WorkspaceHarness />));
    expect(filtersRequested()).toEqual([]);
    await act(async () => list.resolve({ collections: withDefaults() }));
    expect(workspace.view).toMatchObject({ collectionId: "one", filter: "unread", page: 1 });
    expect(filtersRequested()).toEqual(["unread"]);
    expect(container.textContent).toBe("unread");
    defaults = { one: "errors", two: "all" };
    await act(async () => workspace.loadCollections());
    expect(workspace.view).toMatchObject({ collectionId: "one", filter: "unread" });
    await act(async () => workspace.setSelectedId("two"));
    expect(workspace.view).toMatchObject({ collectionId: "two", filter: "all" });
    await act(async () => workspace.setFilter("unread"));
    await act(async () => workspace.setSelectedId("one"));
    expect(workspace.view).toMatchObject({ collectionId: "one", filter: "errors" });
    expect(filtersRequested().at(-1)).toBe("errors");
  });
  it("requests server pages and resets search, status and collection changes to page one", async () => {
    request.mockImplementation(async (path) => path === "/api/collections" ? { collections } : {
      subscriptions: [subscription("entry")], total: 100, page: Number(new URL(path, "http://test").searchParams.get("page") || "1"), pageCount: 4,
    });
    await act(async () => root.render(<PagedWorkspaceHarness />));
    expect(request.mock.calls.at(-1)![0]).toContain("page=1&pageSize=25");
    await act(async () => workspace.setPage(4)); expect(workspace.page).toBe(4);
    await act(async () => workspace.setSearch("Сериал")); expect(workspace.page).toBe(1); expect(request.mock.calls.at(-1)![0]).toContain("search=%D0%A1");
    await act(async () => workspace.setPage(3));
    await act(async () => workspace.setFilter("unread")); expect(workspace.page).toBe(1); expect(request.mock.calls.at(-1)![0]).toContain("filter=unread");
    await act(async () => workspace.setPage(2));
    await act(async () => workspace.setSelectedId("two")); expect(workspace.page).toBe(1);
    await act(async () => root.render(<PagedWorkspaceHarness enabled={false} />));
    expect(request.mock.calls.at(-1)![0]).not.toContain("page=");
  });
  it("ignores a late page response after a filter change", async () => {
    const old = deferred<{ subscriptions: SubscriptionSummary[] }>();
    request.mockImplementation(async (path) => path === "/api/collections" ? { collections } : path.includes("filter=unread") ? { subscriptions: [subscription("unread")] } : old.promise);
    await act(async () => root.render(<PagedWorkspaceHarness />));
    await act(async () => workspace.setFilter("unread"));
    await act(async () => old.resolve({ subscriptions: [subscription("old-page")] }));
    expect(container.textContent).toBe("unread");
  });
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

describe("polling pauses while the page is hidden", () => {
  function IntervalHarness({ callback, delay }: { callback: () => void; delay: number | null }) { useVisibleInterval(callback, delay); return null; }
  it("stops the interval while hidden and refreshes once on return, and stays off with a null delay", async () => {
    const tick = vi.fn();
    await act(async () => root.render(<IntervalHarness callback={tick} delay={1_000} />));
    await act(async () => vi.advanceTimersByTime(2_000));
    expect(tick).toHaveBeenCalledTimes(2);
    await setVisibility("hidden");
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => vi.advanceTimersByTime(10_000));
    expect(tick).toHaveBeenCalledTimes(2);
    await setVisibility("visible");
    expect(tick).toHaveBeenCalledTimes(3);
    await setVisibility("visible");
    expect(tick).toHaveBeenCalledTimes(3);
    await act(async () => vi.advanceTimersByTime(1_000));
    expect(tick).toHaveBeenCalledTimes(4);
    await act(async () => root.render(<IntervalHarness callback={tick} delay={null} />));
    await act(async () => vi.advanceTimersByTime(5_000));
    await setVisibility("hidden"); await setVisibility("visible");
    expect(tick).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("starts paused in a hidden tab", async () => {
    visibility = "hidden";
    const tick = vi.fn();
    await act(async () => root.render(<IntervalHarness callback={tick} delay={1_000} />));
    await act(async () => vi.advanceTimersByTime(5_000));
    expect(tick).not.toHaveBeenCalled();
    await setVisibility("visible");
    expect(tick).toHaveBeenCalledOnce();
  });

  it("pauses the workspace refresh and reloads collections and subscriptions when the tab returns", async () => {
    request.mockImplementation(async (path) => path === "/api/collections" ? { collections } : { subscriptions: [subscription("entry")] });
    await act(async () => root.render(<WorkspaceHarness />));
    const calls = () => ({ collections: request.mock.calls.filter(([path]) => path === "/api/collections").length, subscriptions: request.mock.calls.filter(([path]) => path.startsWith("/api/subscriptions?")).length });
    expect(calls()).toEqual({ collections: 1, subscriptions: 1 });
    await setVisibility("hidden");
    await act(async () => vi.advanceTimersByTime(120_000));
    expect(calls()).toEqual({ collections: 1, subscriptions: 1 });
    await setVisibility("visible");
    expect(calls()).toEqual({ collections: 2, subscriptions: 2 });
    await act(async () => vi.advanceTimersByTime(30_000));
    expect(calls()).toEqual({ collections: 3, subscriptions: 3 });
  });

  it("pauses scheduler status polling, including the scheduled next-run refresh, and refreshes on return", async () => {
    request.mockResolvedValue({ ...statusResponse, scheduler: { ...statusResponse.scheduler, nextRunAt: new Date(Date.now() + 60_000).toISOString() } });
    await act(async () => root.render(<SchedulerHarness />));
    expect(request).toHaveBeenCalledTimes(1);
    await setVisibility("hidden");
    await act(async () => vi.advanceTimersByTime(120_000));
    expect(request).toHaveBeenCalledTimes(1);
    await setVisibility("visible");
    expect(request).toHaveBeenCalledTimes(2);
    await act(async () => vi.advanceTimersByTime(30_000));
    expect(request).toHaveBeenCalledTimes(3);
  });
});
