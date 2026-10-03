// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { api } from "../api";
import { DialogProvider } from "../components/Dialogs";
import { setLanguage } from "../i18n";
import type { ActivityFilter } from "../routing";
import type { ActivityEvent, Collection, User } from "../types";
import { Activity } from "./Activity";

vi.mock("../api", async (original) => ({ ...await original<object>(), api: vi.fn() }));
afterEach(() => { vi.resetAllMocks(); setLanguage("en"); document.body.innerHTML = ""; });

const user: User = { id: "user", username: "test", isAdmin: false, mustChangePassword: false, trackerMarkerStyle: "icons", language: "en", paginationEnabled: true, pageSize: 2, theme: "sentinel" };
const today = new Date(), dayAt = (offset: number, hour = 12) => new Date(today.getFullYear(), today.getMonth(), today.getDate() - offset, hour).toISOString();
const direct = { type: "direct" as const, directUrl: "https://rutor.info/torrent/1", requiredTerms: [], ignoredTerms: [], trackerKeys: ["rutor" as const] };
const events: ActivityEvent[] = [
  { id: "e1", kind: "direct-change", summary: "title changed", createdAt: new Date(Date.now() - 60_000).toISOString(), readAt: null, isUnread: true,
    payload: { changes: ["title changed", "magnet changed"], previous: { title: "Old cut" }, current: { title: "Director's cut" } },
    subscription: { ...direct, id: "d1", label: "Director's cut" }, collection: { id: "films", name: "Films" } },
  { id: "e2", kind: "rule-match", summary: "New match", createdAt: dayAt(1), readAt: null, isUnread: true, payload: { releases: [{ title: "Dune 2160p" }, { title: "Dune 1080p" }, { title: "Dune 720p" }] },
    subscription: { id: "r1", type: "rule", label: "Dune + 2160p", requiredTerms: ["Dune", "2160p"], ignoredTerms: [], trackerKeys: ["rutracker", "kinozal", "rutor"] }, collection: { id: "series", name: "Series" } },
  { id: "e3", kind: "direct-change", summary: "Release changed", createdAt: dayAt(9), readAt: null, isUnread: true, payload: {},
    subscription: { ...direct, id: "d2", label: "Archived" }, collection: { id: "films", name: "Films" } },
];
function render(filter: ActivityFilter, collections: Collection[]) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container), notify = vi.fn(), onCollectionsChanged = vi.fn(async () => undefined), onFilterChange = vi.fn(), onShowShortcuts = vi.fn();
  return { container, root, notify, onCollectionsChanged, onFilterChange, onShowShortcuts, mount: () => act(async () => root.render(<DialogProvider><Activity user={user} notify={notify} filter={filter} onFilterChange={onFilterChange} collections={collections} onCollectionsChanged={onCollectionsChanged} onShowShortcuts={onShowShortcuts} /></DialogProvider>)) };
}
const collections: Collection[] = [{ id: "films", name: "Films", subscriptionCount: 4, unreadCount: 2, activityCount: 2, errorCount: 0 }, { id: "series", name: "Series", subscriptionCount: 1, unreadCount: 1, activityCount: 1, errorCount: 0 }];

it("groups unread changes by day, loads more pages, and opens an entry in the inspector", async () => {
  let unread = [...events];
  vi.mocked(api).mockImplementation(async (path, options) => {
    if (path.startsWith("/api/activity?")) {
      const query = new URL(path, "http://test").searchParams, page = Number(query.get("page")), size = Number(query.get("pageSize"));
      expect(query.get("filter")).toBe("unread");
      return { events: unread.slice((page - 1) * size, page * size), total: unread.length, page, pageCount: Math.max(1, Math.ceil(unread.length / size)) };
    }
    if (path === "/api/subscriptions/r1/open" && options?.method === "POST") {
      unread = unread.filter((event) => event.subscription.id !== "r1");
      return { subscription: { id: "r1", collectionId: "series", type: "rule", label: "Dune + 2160p", requiredTerms: ["Dune", "2160p"], ignoredTerms: [], trackerKeys: ["rutracker"], enabled: true, initialized: true, isUnread: false, unreadCount: 0, eventCount: 1, matchCount: 0, createdAt: dayAt(30) }, events: [], matches: [] };
    }
    throw new Error(`Unexpected request: ${path}`);
  });
  const view = render("unread", collections);
  try {
    await view.mount();
    expect(view.container.querySelector("h1")?.textContent).toBe("Activity");
    expect(view.container.querySelector(".activity-count")?.textContent).toBe("3 unread changes");
    expect([...view.container.querySelectorAll(".activity-day h2")].map((heading) => heading.textContent)).toEqual(["Today", "Yesterday"]);
    const [first, second] = [...view.container.querySelectorAll<HTMLButtonElement>(".activity-entry")];
    expect(first.querySelector(".activity-entry__label")?.textContent).toBe("Director's cut");
    expect(first.querySelector(".change-summary")?.textContent).toBe("Title changed, magnet changed · Previous title: Old cut→New title: Director's cut");
    expect(first.querySelector(".activity-entry__collection")?.textContent).toBe("Films");
    expect(first.querySelector(".activity-entry__time")?.textContent).toBe("1 minute ago");
    expect(first.querySelector(".activity-entry__time")?.getAttribute("title")).toBeTruthy();
    expect(first.querySelector(".type-icon .unread-dot")).not.toBeNull();
    expect([...second.querySelectorAll(".phrase-chip")].map((chip) => chip.textContent)).toEqual(["Dune", "2160p"]);
    expect(second.querySelector(".change-summary")?.textContent).toBe("3 new matches: Dune 2160p, Dune 1080p +1 more");
    expect(second.querySelectorAll(".tracker-tag")).toHaveLength(3);

    await act(async () => [...view.container.querySelectorAll<HTMLButtonElement>(".activity-more button")][0].click());
    expect(vi.mocked(api).mock.calls.filter(([path]) => path.includes("page=2")).length).toBeGreaterThan(0);
    expect(view.container.querySelectorAll(".activity-entry")).toHaveLength(3);
    expect(view.container.querySelectorAll(".activity-day h2")).toHaveLength(3);
    expect(view.container.querySelector(".activity-more")).toBeNull();

    await act(async () => second.click());
    expect(api).toHaveBeenCalledWith("/api/subscriptions/r1/open", expect.objectContaining({ method: "POST" }));
    expect(document.querySelector(".drawer h2")?.textContent).toBe("Dune + 2160p");
    expect(view.onCollectionsChanged).toHaveBeenCalled();
    expect([...view.container.querySelectorAll(".activity-entry")].map((entry) => entry.querySelector(".activity-entry__label")?.textContent)).toEqual(["Director's cut", "Archived"]);
    expect(view.container.querySelector(".activity-count")?.textContent).toBe("2 unread changes");
    await act(async () => document.querySelector<HTMLButtonElement>('.drawer button[aria-label="Close"]')!.click());
    expect(document.querySelector(".drawer")).toBeNull();

    await act(async () => setLanguage("ru"));
    expect(view.container.querySelector("h1")?.textContent).toBe("Активность");
    expect(view.container.querySelector(".activity-day h2")?.textContent).toBe("Сегодня");
  } finally { await act(async () => view.root.unmount()); }
});

it("lists Mark unread reminders above the changes and counts them separately in the header", async () => {
  const reminder = { subscription: { ...direct, id: "d9", label: "Kept for later" }, collection: { id: "films", name: "Films" }, lastChangedAt: dayAt(3) };
  let reminders = [reminder];
  vi.mocked(api).mockImplementation(async (path, options) => {
    if (path.startsWith("/api/activity?")) return { events: [events[0]], total: 1, page: 1, pageCount: 1, reminders };
    if (path === "/api/subscriptions/d9/open" && options?.method === "POST") {
      reminders = [];
      return { subscription: { id: "d9", collectionId: "films", type: "direct", label: "Kept for later", directUrl: direct.directUrl, requiredTerms: [], ignoredTerms: [], trackerKeys: ["rutor"], enabled: true, initialized: true, isUnread: false, unreadCount: 0, eventCount: 0, matchCount: 0, createdAt: dayAt(30) }, events: [], matches: [] };
    }
    throw new Error(`Unexpected request: ${path}`);
  });
  const view = render("unread", collections);
  try {
    await view.mount();
    expect(view.container.querySelector(".activity-count")?.textContent).toBe("1 unread change · 1 marked unread");
    expect([...view.container.querySelectorAll(".activity-day h2")].map((heading) => heading.textContent)).toEqual(["Marked unread", "Today"]);
    const entry = view.container.querySelector<HTMLButtonElement>(".activity-reminders .activity-entry")!;
    expect(entry.classList.contains("activity-entry--unread")).toBe(true);
    expect(entry.querySelector(".activity-entry__label")?.textContent).toBe("Kept for later");
    expect(entry.querySelector(".change-summary")?.textContent).toBe("Marked unread by you");
    expect(entry.querySelector(".activity-entry__time")?.textContent).toBe("3 days ago");
    await act(async () => entry.click());
    expect(api).toHaveBeenCalledWith("/api/subscriptions/d9/open", expect.objectContaining({ method: "POST" }));
    expect(view.container.querySelector(".activity-reminders")).toBeNull();
    expect(view.container.querySelector(".activity-count")?.textContent).toBe("1 unread change");
  } finally { await act(async () => view.root.unmount()); }
});

it("shows the caught-up and empty states and switches filters", async () => {
  vi.mocked(api).mockResolvedValue({ events: [], total: 0, page: 1, pageCount: 1 });
  const unread = render("unread", []);
  try {
    await unread.mount();
    expect(unread.container.querySelector(".empty-state h2")?.textContent).toBe("You’re all caught up");
    expect(unread.container.querySelector<HTMLButtonElement>(".page-header .button")!.disabled).toBe(true);
    await act(async () => unread.container.querySelector<HTMLButtonElement>(".empty-state .button")!.click());
    expect(unread.onFilterChange).toHaveBeenCalledWith("all");
  } finally { await act(async () => unread.root.unmount()); }
  const all = render("all", []);
  try {
    await all.mount();
    expect(api).toHaveBeenLastCalledWith("/api/activity?filter=all&page=1&pageSize=2", expect.anything());
    expect(all.container.querySelector(".empty-state h2")?.textContent).toBe("No changes yet");
    expect(all.container.querySelector(".filter-tabs .active")?.textContent).toBe("All");
  } finally { await act(async () => all.root.unmount()); }
});

it("marks everything read after confirming with the number of unread subscriptions", async () => {
  let remaining = [events[0]];
  vi.mocked(api).mockImplementation(async (path, options) => {
    if (path === "/api/activity/read" && options?.method === "POST") { remaining = []; return { ok: true, subscriptions: 3, events: 3 }; }
    return { events: remaining, total: remaining.length, page: 1, pageCount: 1 };
  });
  const view = render("unread", collections);
  try {
    await view.mount();
    await act(async () => view.container.querySelector<HTMLButtonElement>(".page-header .button")!.click());
    expect(view.container.querySelector(".app-dialog h2")?.textContent).toBe("Mark everything as read?");
    expect(view.container.querySelector(".app-dialog__description")?.textContent).toContain("3 unread subscriptions across all collections will be marked read.");
    await act(async () => view.container.querySelector(".app-dialog form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(api).toHaveBeenCalledWith("/api/activity/read", expect.objectContaining({ method: "POST", body: "{}" }));
    expect(view.notify).toHaveBeenCalledWith("Everything marked read");
    expect(view.onCollectionsChanged).toHaveBeenCalled();
    expect(view.container.querySelector(".empty-state h2")?.textContent).toBe("You’re all caught up");
  } finally { await act(async () => view.root.unmount()); }
});

it("shows the filters as pressed toggle buttons with the unread total, and moves through entries with j and k", async () => {
  vi.mocked(api).mockResolvedValue({ events, total: 3, page: 1, pageCount: 1 });
  const view = render("unread", collections);
  const press = async (key: string, options: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options });
    await act(async () => { (document.activeElement ?? document.body).dispatchEvent(event); });
    return event;
  };
  try {
    await view.mount();
    const group = view.container.querySelector<HTMLElement>('.filter-tabs[role="group"]')!;
    expect(group.getAttribute("aria-label")).toBe("Filter changes");
    expect([...group.querySelectorAll("button")].map((button) => [button.textContent, button.getAttribute("aria-pressed")])).toEqual([["Unread 3", "true"], ["All", "false"]]);
    await act(async () => group.querySelectorAll("button")[1].click());
    expect(view.onFilterChange).toHaveBeenCalledWith("all");
    await act(async () => setLanguage("ru"));
    expect([...group.querySelectorAll("button")].map((button) => button.textContent)).toEqual(["Непрочитанные 3", "Все"]);
    await act(async () => setLanguage("en"));

    const entries = () => [...view.container.querySelectorAll<HTMLButtonElement>(".activity-entry")];
    await press("j"); expect(document.activeElement).toBe(entries()[0]);
    await press("j"); expect(document.activeElement).toBe(entries()[1]);
    await press("k"); expect(document.activeElement).toBe(entries()[0]);
    entries()[0].blur();
    await press("k"); expect(document.activeElement).toBe(entries()[2]);
    await press("?", { shiftKey: true }); expect(view.onShowShortcuts).toHaveBeenCalledOnce();
    // Monitor-only shortcuts do nothing here.
    expect((await press("a")).defaultPrevented).toBe(false);
    expect((await press("/")).defaultPrevented).toBe(false);
  } finally { await act(async () => view.root.unmount()); }
});

it("stops polling while the tab is hidden and refreshes when it returns", async () => {
  vi.useFakeTimers();
  let visibility: DocumentVisibilityState = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  const setVisibility = (state: DocumentVisibilityState) => act(async () => { visibility = state; document.dispatchEvent(new Event("visibilitychange")); });
  vi.mocked(api).mockResolvedValue({ events: [], total: 0, page: 1, pageCount: 1 });
  const view = render("unread", collections);
  const requests = () => vi.mocked(api).mock.calls.filter(([path]) => path.startsWith("/api/activity?")).length;
  try {
    await view.mount();
    expect(requests()).toBe(1);
    await act(async () => vi.advanceTimersByTime(30_000));
    expect(requests()).toBe(2);
    await setVisibility("hidden");
    await act(async () => vi.advanceTimersByTime(120_000));
    expect(requests()).toBe(2);
    await setVisibility("visible");
    expect(requests()).toBe(3);
    await act(async () => vi.advanceTimersByTime(30_000));
    expect(requests()).toBe(4);
  } finally { await act(async () => view.root.unmount()); vi.useRealTimers(); Reflect.deleteProperty(document, "visibilityState"); }
});
