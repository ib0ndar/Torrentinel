// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { api } from "../api";
import { DialogProvider } from "../components/Dialogs";
import { setLanguage } from "../i18n";
import type { SubscriptionSummary, TrackerKey, User } from "../types";
import { Workspace } from "./Workspace";
import { useWorkspaceData } from "../hooks/useWorkspaceData";

vi.mock("../api", async (original) => ({ ...await original<object>(), api: vi.fn() }));
afterEach(() => { vi.resetAllMocks(); setLanguage("en"); });

it("shows compact top navigation only for several pages and keeps the page size below the list", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const user: User = { id: "user", username: "test", isAdmin: false, mustChangePassword: false, trackerMarkerStyle: "icons", language: "en", paginationEnabled: true, pageSize: 20, theme: "sentinel", startPage: "monitor" };
  let total = 25;
  vi.mocked(api).mockImplementation(async (path) => {
    if (path === "/api/collections") return { collections: [{ id: "inbox", name: "Inbox", subscriptionCount: total, unreadCount: 0 }] };
    const page = Number(new URL(path, "http://test").searchParams.get("page") || "1"), pageCount = Math.ceil(total / 20);
    const subscriptions: SubscriptionSummary[] = Array.from({ length: page < pageCount ? 20 : total - (pageCount - 1) * 20 }, (_, index) => ({
      id: String((page - 1) * 20 + index + 1), label: `Release ${(page - 1) * 20 + index + 1}`, collectionId: "inbox", type: "direct", requiredTerms: [], ignoredTerms: [], trackerKeys: ["rutor"],
      enabled: true, initialized: true, isUnread: false, unreadCount: 0, eventCount: 0, matchCount: 0, createdAt: "2026-09-30T00:00:00Z",
    }));
    return { subscriptions, total, page, pageCount };
  });
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container), notify = vi.fn(), onUserChange = vi.fn();
  function Harness({ current }: { current: User }) {
    const data = useWorkspaceData(notify, current.paginationEnabled, current.pageSize);
    return <DialogProvider><Workspace user={current} onUserChange={onUserChange} notify={notify} data={data} onNewCollection={() => undefined} /></DialogProvider>;
  }
  const render = (current: User) => <Harness current={current} />;
  const button = (navigation: Element, label: string) => navigation.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
  const top = () => container.querySelector('nav[aria-label="Pagination"]'), bottom = () => container.querySelector('nav[aria-label="Bottom pagination"]')!;
  try {
    await act(async () => root.render(render(user)));
    expect(top()!.querySelector("select")).toBeNull();
    expect(top()!.textContent).toBe("Page 1 of 2 · 25 entries«‹›»");
    expect(bottom().querySelector(".pagination-size-picker > span")?.textContent).toBe("Entries per page");
    expect(bottom().querySelector<HTMLSelectElement>(".pagination-size-picker select")?.value).toBe("20");
    expect(container.querySelectorAll(".pagination-navigation")).toHaveLength(2);
    expect(bottom().textContent).toContain("Page 1 of 2 · 25 entries");
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(1);
    expect(top()!.querySelector('[role="status"]')).not.toBeNull();
    expect(container.querySelector(".subscription-list")?.nextElementSibling).toBe(bottom());
    for (const nav of [top()!, bottom()]) { expect(button(nav, "First page").disabled).toBe(true); expect(button(nav, "Next page").disabled).toBe(false); }
    await act(async () => button(bottom(), "Next page").click());
    for (const nav of [top()!, bottom()]) { expect(nav.textContent).toContain("Page 2 of 2 · 25 entries"); expect(button(nav, "Next page").disabled).toBe(true); expect(button(nav, "Previous page").disabled).toBe(false); }
    expect(container.querySelectorAll(".subscription-row")).toHaveLength(5);
    await act(async () => button(top()!, "First page").click());
    expect(bottom().textContent).toContain("Page 1 of 2 · 25 entries"); expect(container.querySelectorAll(".subscription-row")).toHaveLength(20);
    const bottomNavigation = bottom();
    await act(async () => setLanguage("ru"));
    expect(bottomNavigation.getAttribute("aria-label")).toBe("Навигация под списком"); expect(bottomNavigation.textContent).toContain("Страница 1 из 2");
    await act(async () => setLanguage("en"));

    // One page: no navigation at all, only the page size below the list.
    total = 7;
    await act(async () => container.querySelector<HTMLButtonElement>(".filter-tabs button:nth-child(2)")!.click());
    expect(top()).toBeNull();
    expect(container.querySelectorAll(".pagination-navigation")).toHaveLength(0);
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(0);
    expect(bottom().querySelector(".pagination-size-picker select")).not.toBeNull();
    expect(container.querySelectorAll(".subscription-row")).toHaveLength(7);
    await act(async () => root.render(render({ ...user, paginationEnabled: false })));
    expect(container.querySelectorAll("nav.pagination")).toHaveLength(0);
  } finally { await act(async () => root.unmount()); container.remove(); }
});

it("shows the last change with the last check as a tooltip, keeps the type icon for unread rows, and sorts on the server", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const user: User = { id: "user", username: "test", isAdmin: false, mustChangePassword: false, trackerMarkerStyle: "icons", language: "en", paginationEnabled: false, pageSize: 20, theme: "sentinel", startPage: "monitor" };
  const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
  const base = { collectionId: "inbox", requiredTerms: [] as string[], ignoredTerms: [] as string[], trackerKeys: ["rutor", "kinozal", "rutracker"] as TrackerKey[], enabled: true, initialized: true, unreadCount: 0, eventCount: 0, matchCount: 0, createdAt: "2026-09-30T00:00:00Z" };
  const subscriptions: SubscriptionSummary[] = [
    { ...base, id: "1", type: "direct", label: "Changed release", isUnread: true, unreadCount: 2, lastChangedAt: minutesAgo(120), lastCheckedAt: minutesAgo(5) },
    { ...base, id: "2", type: "rule", label: "Dune", requiredTerms: ["Dune"], isUnread: false, lastChangedAt: null, lastCheckedAt: null },
  ];
  vi.mocked(api).mockImplementation(async (path) => {
    if (path === "/api/collections") return { collections: [{ id: "inbox", name: "Inbox", subscriptionCount: 2, unreadCount: 1 }] };
    return { subscriptions, total: 2, page: 1, pageCount: 1 };
  });
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container), notify = vi.fn();
  function Harness() {
    const data = useWorkspaceData(notify, false, 20);
    return <DialogProvider><Workspace user={user} onUserChange={vi.fn()} notify={notify} data={data} onNewCollection={() => undefined} /></DialogProvider>;
  }
  try {
    await act(async () => root.render(<Harness />));
    expect([...container.querySelectorAll(".subscription-head span")].map((cell) => cell.textContent)).toEqual(["Subscription", "Source", "Last change", "Status"]);
    const [changed, rule] = [...container.querySelectorAll(".subscription-row")];
    expect(changed.querySelector(".time-cell")?.textContent).toBe("2 hours ago");
    expect(changed.querySelector(".time-cell")?.getAttribute("title")).toBe("Last checked 5 minutes ago");
    expect(rule.querySelector(".time-cell__none")?.textContent).toBe("No changes yet");
    expect(rule.querySelector(".time-cell")?.getAttribute("title")).toBe("Waiting for first check");
    const unreadIcon = changed.querySelector(".type-icon")!;
    expect(unreadIcon.getAttribute("aria-label")).toBe("Unread direct Subscription");
    expect(unreadIcon.querySelector("use")?.getAttribute("href")).toMatch(/#ti-link$/);
    expect(unreadIcon.querySelector(".unread-dot")).not.toBeNull();
    expect(rule.querySelector(".type-icon use")?.getAttribute("href")).toMatch(/#ti-keyword$/);
    expect(rule.querySelector(".type-icon")?.getAttribute("aria-label")).toBe("Read rule Subscription");
    expect(rule.querySelector(".unread-dot")).toBeNull();
    expect(changed.querySelectorAll(".tracker-stack .tracker-tag")).toHaveLength(3);

    const sort = container.querySelector<HTMLSelectElement>('select[aria-label="Sort"]')!;
    expect([...sort.options].map((option) => option.textContent)).toEqual(["Last change", "Name (A–Z)", "Needs attention first"]);
    expect(vi.mocked(api).mock.calls.at(-1)![0]).not.toContain("sort=");
    await act(async () => { sort.value = "attention"; sort.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(vi.mocked(api).mock.calls.at(-1)![0]).toContain("sort=attention");
    // The visible placeholder is short enough for the phone toolbar; the accessible name stays descriptive.
    const searchInput = () => container.querySelector<HTMLInputElement>(".search-box input")!;
    expect(searchInput().placeholder).toBe("Search");
    expect(searchInput().getAttribute("aria-label")).toBe("Filter this collection");
    // Russian labels stay short enough for the phone toolbar; the column shares the date label.
    await act(async () => setLanguage("ru"));
    expect([...sort.options].map((option) => option.textContent)).toEqual(["Дата изменения", "Название (А–Я)", "Сначала ошибки"]);
    expect(searchInput().placeholder).toBe("Поиск");
    expect(searchInput().getAttribute("aria-label")).toBe("Поиск в коллекции");
    expect(container.querySelectorAll(".subscription-head span")[2]?.textContent).toBe("Дата изменения");
  } finally { await act(async () => root.unmount()); container.remove(); }
});

it("marks a collection read after confirming, from the header or the more-actions menu", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const user: User = { id: "user", username: "test", isAdmin: false, mustChangePassword: false, trackerMarkerStyle: "icons", language: "en", paginationEnabled: false, pageSize: 20, theme: "sentinel", startPage: "monitor" };
  let unread = 3;
  vi.mocked(api).mockImplementation(async (path, options) => {
    if (path === "/api/collections") return { collections: [{ id: "inbox", name: "Inbox", subscriptionCount: 5, unreadCount: unread }] };
    if (path === "/api/activity/read" && options?.method === "POST") { unread = 0; return { ok: true, subscriptions: 3, events: 4 }; }
    return { subscriptions: [], total: 0, page: 1, pageCount: 1 };
  });
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container), notify = vi.fn();
  function Harness() {
    const data = useWorkspaceData(notify, false, 20);
    return <DialogProvider><Workspace user={user} onUserChange={vi.fn()} notify={notify} data={data} onNewCollection={() => undefined} /></DialogProvider>;
  }
  const menuItems = () => [...document.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitem"]')];
  const submitDialog = () => container.querySelector(".app-dialog form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  try {
    await act(async () => root.render(<Harness />));
    await act(async () => container.querySelector<HTMLButtonElement>(".header-more")!.click());
    expect(menuItems().map((item) => item.textContent)).toEqual(["Mark all read", "Edit collection", "Delete collection"]);
    await act(async () => menuItems()[0].click());
    expect(container.querySelector(".app-dialog h2")?.textContent).toBe("Mark “Inbox” as read?");
    expect(container.querySelector(".app-dialog__description")?.textContent).toContain("3 unread subscriptions in this collection will be marked read.");
    expect(container.querySelector(".app-dialog--default")).not.toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>(".app-dialog .button--quiet")!.click());
    expect(vi.mocked(api)).not.toHaveBeenCalledWith("/api/activity/read", expect.anything());

    const header = container.querySelector<HTMLButtonElement>(".header-read")!;
    expect(header.textContent).toBe("Mark all read");
    await act(async () => header.click());
    await act(async () => submitDialog());
    expect(vi.mocked(api)).toHaveBeenCalledWith("/api/activity/read", expect.objectContaining({ method: "POST", body: JSON.stringify({ collectionId: "inbox" }) }));
    expect(notify).toHaveBeenCalledWith("Collection marked read");
    expect(container.querySelector(".header-read")).toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>(".header-more")!.click());
    expect(menuItems().map((item) => item.textContent)).toEqual(["Edit collection", "Delete collection"]);
  } finally { await act(async () => root.unmount()); container.remove(); }
});

it("edits the name and default view and deletes the collection from the more-actions menu", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const user: User = { id: "user", username: "test", isAdmin: false, mustChangePassword: false, trackerMarkerStyle: "icons", language: "en", paginationEnabled: false, pageSize: 20, theme: "sentinel", startPage: "monitor" };
  let stored = { id: "inbox", name: "Inbox", defaultFilter: "all", subscriptionCount: 2, unreadCount: 0, errorCount: 0 };
  vi.mocked(api).mockImplementation(async (path, init) => {
    if (path === "/api/collections") return { collections: [stored] };
    if (path === "/api/collections/inbox" && init?.method === "PATCH") { stored = { ...stored, ...JSON.parse(String(init.body)) }; return { ok: true }; }
    if (path.startsWith("/api/subscriptions?")) return { subscriptions: [], total: 0, page: 1, pageCount: 1 };
    return {};
  });
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container), notify = vi.fn();
  function Harness() {
    const data = useWorkspaceData(notify, false, 20);
    return <DialogProvider><Workspace user={user} onUserChange={vi.fn()} notify={notify} data={data} onNewCollection={() => undefined} /></DialogProvider>;
  }
  const more = () => container.querySelector<HTMLButtonElement>(".header-more")!;
  const choose = (label: string) => [...document.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitem"]')].find((item) => item.textContent === label)!;
  const submitDialog = () => container.querySelector(".app-dialog form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  const drawer = () => document.querySelector<HTMLElement>(".drawer");
  const nameInput = () => drawer()!.querySelector<HTMLInputElement>('input[maxlength="80"]')!;
  const choices = () => [...drawer()!.querySelectorAll<HTMLInputElement>('input[name="default-filter"]')];
  const save = () => drawer()!.querySelector<HTMLButtonElement>(".drawer-actions .button--primary")!;
  const submitDrawer = () => act(async () => drawer()!.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  const activeFilter = () => container.querySelector(".filter-tabs .active .filter-tabs__label")?.textContent;
  try {
    await act(async () => root.render(<Harness />));
    expect(container.querySelector('.header-action[aria-label="Edit collection"]')).not.toBeNull();
    expect(container.querySelector('.header-action[aria-label="Delete collection"]')).not.toBeNull();
    expect(more().getAttribute("aria-label")).toBe("Collection actions");
    await act(async () => more().click());
    expect(document.querySelector('[role="menu"]')?.getAttribute("aria-label")).toBe("Collection actions");
    await act(async () => choose("Edit collection").click());
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(drawer()?.querySelector("h2")?.textContent).toBe("Edit collection");
    expect(drawer()?.querySelector("legend")?.textContent).toBe("Default view");
    expect(nameInput().value).toBe("Inbox");
    expect(choices().map((input) => [input.value, input.checked])).toEqual([["all", true], ["unread", false], ["errors", false]]);
    expect(save().textContent).toBe("Save changes");
    expect(save().disabled).toBe(true);
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(nameInput(), "Watchlist "); nameInput().dispatchEvent(new Event("input", { bubbles: true })); });
    expect(save().disabled).toBe(false);
    await submitDrawer();
    expect(vi.mocked(api)).toHaveBeenCalledWith("/api/collections/inbox", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ name: "Watchlist" }) }));
    expect(notify).toHaveBeenLastCalledWith("Collection updated");
    expect(drawer()).toBeNull();
    expect(container.querySelector("h1")?.textContent).toBe("Watchlist");

    // A new default applies the next time the collection is opened; the view on screen stays.
    await act(async () => container.querySelector<HTMLButtonElement>('.header-action[aria-label="Edit collection"]')!.click());
    await act(async () => choices()[1].click());
    expect(choices()[1].closest("label")?.classList.contains("active")).toBe(true);
    await submitDrawer();
    expect(vi.mocked(api)).toHaveBeenCalledWith("/api/collections/inbox", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ defaultFilter: "unread" }) }));
    expect(activeFilter()).toBe("All");
    expect(vi.mocked(api).mock.calls.some(([path]) => path.includes("filter=unread"))).toBe(false);
    await act(async () => container.querySelector<HTMLButtonElement>('.header-action[aria-label="Edit collection"]')!.click());
    expect([nameInput().value, choices().find((input) => input.checked)?.value]).toEqual(["Watchlist", "unread"]);
    await act(async () => drawer()!.querySelector<HTMLButtonElement>(".drawer-actions .button--quiet")!.click());
    expect(drawer()).toBeNull();

    await act(async () => more().click());
    await act(async () => choose("Delete collection").click());
    expect(container.querySelector(".app-dialog h2")?.textContent).toBe("Delete “Watchlist”?");
    await act(async () => submitDialog());
    expect(vi.mocked(api)).toHaveBeenCalledWith("/api/collections/inbox", { method: "DELETE" });
    expect(notify).toHaveBeenCalledWith("Collection deleted");
  } finally { await act(async () => root.unmount()); container.remove(); }
});

it("explains an empty Unread or Errors view and offers to show all, but keeps the search hint while searching", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const user: User = { id: "user", username: "test", isAdmin: false, mustChangePassword: false, trackerMarkerStyle: "icons", language: "en", paginationEnabled: false, pageSize: 20, theme: "sentinel", startPage: "monitor" };
  const release: SubscriptionSummary = { id: "1", label: "Release", collectionId: "inbox", type: "direct", requiredTerms: [], ignoredTerms: [], trackerKeys: ["rutor"],
    enabled: true, initialized: true, isUnread: false, unreadCount: 0, eventCount: 0, matchCount: 0, createdAt: "2026-09-30T00:00:00Z" };
  vi.mocked(api).mockImplementation(async (path) => {
    if (path === "/api/collections") return { collections: [{ id: "inbox", name: "Inbox", defaultFilter: "unread", subscriptionCount: 1, unreadCount: 0, activityCount: 0, errorCount: 0 }] };
    const filter = new URL(path, "http://test").searchParams.get("filter");
    return filter === "all" ? { subscriptions: [release], total: 1, page: 1, pageCount: 1 } : { subscriptions: [], total: 0, page: 1, pageCount: 1 };
  });
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container), notify = vi.fn();
  function Harness() { const data = useWorkspaceData(notify, false, 20); return <DialogProvider><Workspace user={user} onUserChange={vi.fn()} notify={notify} data={data} onNewCollection={() => undefined} /></DialogProvider>; }
  const empty = () => container.querySelector(".empty-state");
  const filterTab = (label: string) => [...container.querySelectorAll<HTMLButtonElement>(".filter-tabs button")].find((button) => button.querySelector(".filter-tabs__label")?.textContent === label)!;
  vi.useFakeTimers();
  try {
    await act(async () => root.render(<Harness />));
    expect(filterTab("Unread").getAttribute("aria-pressed")).toBe("true");
    expect([empty()?.querySelector("h2")?.textContent, empty()?.querySelector("p")?.textContent]).toEqual(["No unread subscriptions", "New changes in this collection will appear here."]);
    await act(async () => setLanguage("ru"));
    expect(empty()?.querySelector("h2")?.textContent).toBe("Непрочитанных подписок нет");
    await act(async () => setLanguage("en"));
    await act(async () => empty()!.querySelector<HTMLButtonElement>("button")!.click());
    expect(filterTab("All").getAttribute("aria-pressed")).toBe("true");
    expect(empty()).toBeNull();
    expect(container.querySelectorAll(".subscription-row")).toHaveLength(1);

    await act(async () => filterTab("Errors").click());
    expect([empty()?.querySelector("h2")?.textContent, empty()?.querySelector("p")?.textContent, empty()?.querySelector("button")?.textContent])
      .toEqual(["No errors", "No subscription in this collection needs attention.", "Show all"]);

    const search = container.querySelector<HTMLInputElement>(".search-box input")!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "absent"); search.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => vi.advanceTimersByTime(300));
    expect([empty()?.querySelector("h2")?.textContent, empty()?.querySelector("button")]).toEqual(["Nothing matches this view", null]);
  } finally { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); }
});

it("exposes the status filters as pressed toggle buttons with collection counts", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const user: User = { id: "user", username: "test", isAdmin: false, mustChangePassword: false, trackerMarkerStyle: "icons", language: "en", paginationEnabled: false, pageSize: 20, theme: "sentinel", startPage: "monitor" };
  let counts = { subscriptionCount: 12, unreadCount: 3, errorCount: 2 };
  vi.mocked(api).mockImplementation(async (path) => path === "/api/collections" ? { collections: [{ id: "inbox", name: "Inbox", activityCount: 0, ...counts }] } : { subscriptions: [], total: 0, page: 1, pageCount: 1 });
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container), notify = vi.fn();
  function Harness() { const data = useWorkspaceData(notify, false, 20); return <DialogProvider><Workspace user={user} onUserChange={vi.fn()} notify={notify} data={data} onNewCollection={() => undefined} /></DialogProvider>; }
  const group = () => container.querySelector<HTMLElement>('.filter-tabs[role="group"]')!;
  const buttons = () => [...group().querySelectorAll<HTMLButtonElement>("button")];
  vi.useFakeTimers();
  try {
    await act(async () => root.render(<Harness />));
    expect(group().getAttribute("aria-label")).toBe("Filter subscriptions");
    expect(container.querySelector('[role="tablist"], [role="tab"]')).toBeNull();
    expect(buttons().map((button) => [button.textContent, button.getAttribute("aria-pressed")])).toEqual([["All 12", "true"], ["Unread 3", "false"], ["Errors 2", "false"]]);
    expect(buttons()[2].querySelector(".filter-count--alert")).not.toBeNull();
    await act(async () => buttons()[2].click());
    expect(buttons().map((button) => button.getAttribute("aria-pressed"))).toEqual(["false", "false", "true"]);
    expect(vi.mocked(api).mock.calls.at(-1)![0]).toContain("filter=errors");
    await act(async () => setLanguage("ru"));
    expect(buttons().map((button) => button.textContent)).toEqual(["Все 12", "Непрочитанные 3", "Ошибки 2"]);
    await act(async () => setLanguage("en"));
    // Counts follow the collection list on the next background refresh.
    counts = { subscriptionCount: 13, unreadCount: 0, errorCount: 0 };
    await act(async () => vi.advanceTimersByTime(30_000));
    expect(buttons().map((button) => button.textContent)).toEqual(["All 13", "Unread 0", "Errors 0"]);
    expect(buttons()[2].querySelector(".filter-count--alert")).toBeNull();
  } finally { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); }
});

it("supports /, j, k, a and ? on the Monitor and ignores them while typing, with modifiers, or under a menu, drawer or dialog", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const user: User = { id: "user", username: "test", isAdmin: false, mustChangePassword: false, trackerMarkerStyle: "icons", language: "en", paginationEnabled: false, pageSize: 20, theme: "sentinel", startPage: "monitor" };
  const subscriptions: SubscriptionSummary[] = ["One", "Two", "Three"].map((label, index) => ({ id: String(index + 1), label, collectionId: "inbox", type: "direct", requiredTerms: [], ignoredTerms: [], trackerKeys: ["rutor"],
    enabled: true, initialized: true, isUnread: false, unreadCount: 0, eventCount: 0, matchCount: 0, createdAt: "2026-09-30T00:00:00Z" }));
  vi.mocked(api).mockImplementation(async (path) => path === "/api/collections" ? { collections: [{ id: "inbox", name: "Inbox", subscriptionCount: 3, unreadCount: 0, activityCount: 0, errorCount: 0 }] }
    : path === "/api/trackers" ? { trackers: [] } : { subscriptions, total: 3, page: 1, pageCount: 1 });
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container), notify = vi.fn(), showShortcuts = vi.fn();
  function Harness() { const data = useWorkspaceData(notify, false, 20); return <DialogProvider><Workspace user={user} onUserChange={vi.fn()} notify={notify} data={data} onNewCollection={() => undefined} onShowShortcuts={showShortcuts} /></DialogProvider>; }
  const rows = () => [...container.querySelectorAll<HTMLButtonElement>(".subscription-open")];
  const search = () => container.querySelector<HTMLInputElement>(".search-box input")!;
  const press = async (key: string, options: KeyboardEventInit = {}, target: Element = document.activeElement ?? document.body) => {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options });
    await act(async () => { target.dispatchEvent(event); });
    return event;
  };
  try {
    await act(async () => root.render(<Harness />));
    expect(rows()).toHaveLength(3);
    await press("j"); expect(document.activeElement).toBe(rows()[0]);
    await press("j"); expect(document.activeElement).toBe(rows()[1]);
    await press("j"); await press("j"); expect(document.activeElement).toBe(rows()[2]);
    await press("k"); expect(document.activeElement).toBe(rows()[1]);
    rows()[1].blur();
    await press("k"); expect(document.activeElement).toBe(rows()[2]);
    rows()[2].blur();
    // Non-Latin layouts use the physical key.
    await press("о", { code: "KeyJ" }); expect(document.activeElement).toBe(rows()[0]);
    rows()[0].blur();

    expect((await press("/")).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(search());
    const typed = await press("j");
    expect(typed.defaultPrevented).toBe(false); expect(document.activeElement).toBe(search());
    search().blur();
    for (const modifier of ["ctrlKey", "metaKey", "altKey"] as const) {
      const event = await press("j", { [modifier]: true });
      expect(event.defaultPrevented).toBe(false); expect(document.activeElement).toBe(document.body);
    }
    await press("J", { shiftKey: true }); expect(document.activeElement).toBe(document.body);

    await press("?", { shiftKey: true }); expect(showShortcuts).toHaveBeenCalledOnce();

    await act(async () => container.querySelector<HTMLButtonElement>(".header-more")!.click());
    expect(document.querySelector(".menu-popover")).not.toBeNull();
    await press("?", { shiftKey: true }, document.body); await press("a", {}, document.body);
    expect(showShortcuts).toHaveBeenCalledOnce(); expect(document.querySelector(".drawer")).toBeNull();
    await press("Escape");
    expect(document.querySelector(".menu-popover")).toBeNull();

    await press("a");
    expect(document.querySelector(".drawer h2")?.textContent).toBe("Add subscription");
    const field = document.activeElement;
    await press("j", {}, document.body); await press("/", {}, document.body);
    expect(document.activeElement).toBe(field);
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(document.querySelector(".drawer")).toBeNull();

    await act(async () => container.querySelector<HTMLButtonElement>('.header-action[aria-label="Edit collection"]')!.click());
    expect(document.querySelector(".drawer h2")?.textContent).toBe("Edit collection");
    await press("a", {}, document.body);
    expect(document.querySelector(".drawer h2")?.textContent).toBe("Edit collection");
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(document.querySelector(".drawer")).toBeNull();

    await act(async () => container.querySelector<HTMLButtonElement>('.header-action[aria-label="Delete collection"]')!.click());
    expect(container.querySelector(".app-dialog")).not.toBeNull();
    await press("a", {}, document.body);
    expect(document.querySelector(".drawer")).toBeNull();
  } finally { await act(async () => root.unmount()); container.remove(); }
});

it("lists the trackers from the API when adding a subscription and selects every rule tracker by default", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const user: User = { id: "user", username: "test", isAdmin: false, mustChangePassword: false, trackerMarkerStyle: "icons", language: "en", paginationEnabled: false, pageSize: 20, theme: "sentinel", startPage: "monitor" };
  const tracker = (key: TrackerKey, displayName: string, authentication: "none" | "optional" | "required", ruleDiscovery: "feed" | "recent-list" | "search") => ({ key, displayName, hosts: [], snapshotVersion: 1,
    capabilities: { authentication, customMirrors: true, direct: true, rules: true, covers: true, ruleDiscovery }, baseUrl: "", globalBaseUrl: "", hasOverride: false, enabled: true, credentialsConfigured: false });
  const trackers = [tracker("kinozal", "Kinozal", "required", "search"), tracker("rutor", "Rutor", "none", "recent-list"), tracker("rutracker", "RuTracker", "optional", "feed")];
  vi.mocked(api).mockImplementation(async (path) => path === "/api/collections" ? { collections: [{ id: "inbox", name: "Inbox", subscriptionCount: 0, unreadCount: 0, activityCount: 0, errorCount: 0 }] }
    : path === "/api/trackers" ? { trackers } : path === "/api/subscriptions" ? { subscription: {} } : { subscriptions: [], total: 0, page: 1, pageCount: 1 });
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container), notify = vi.fn();
  function Harness() { const data = useWorkspaceData(notify, false, 20); return <DialogProvider><Workspace user={user} onUserChange={vi.fn()} notify={notify} data={data} onNewCollection={() => undefined} /></DialogProvider>; }
  try {
    await act(async () => root.render(<Harness />));
    await act(async () => container.querySelector<HTMLButtonElement>(".header-actions .button--primary")!.click());
    const drawer = document.querySelector<HTMLElement>(".drawer")!;
    expect(drawer.querySelector(".field small")?.textContent).toBe("Kinozal, Rutor, or RuTracker");
    await act(async () => setLanguage("ru"));
    expect(drawer.querySelector(".field small")?.textContent).toBe("Kinozal, Rutor или RuTracker");
    await act(async () => setLanguage("en"));
    await act(async () => [...drawer.querySelectorAll<HTMLButtonElement>(".segmented button")][1].click());
    const choices = () => [...drawer.querySelectorAll<HTMLLabelElement>(".tracker-choice")];
    expect(choices().map((choice) => [choice.querySelector("span:not(.tracker-tag)")?.textContent, choice.querySelector("small")?.textContent ?? null, choice.querySelector("input")!.checked]))
      .toEqual([["Kinozal", "credentials missing", true], ["Rutor", null, true], ["RuTracker", "gap recovery unavailable", true]]);
    await act(async () => choices()[1].querySelector("input")!.click());
    const phrase = drawer.querySelector<HTMLInputElement>('input[aria-label="Required phrases"]')!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(phrase, "Dune"); phrase.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => { phrase.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); });
    await act(async () => drawer.querySelector<HTMLFormElement>("form")!.requestSubmit());
    expect(api).toHaveBeenCalledWith("/api/subscriptions", expect.objectContaining({ method: "POST", body: expect.stringContaining('"trackerKeys":["kinozal","rutracker"]') }));
  } finally { await act(async () => root.unmount()); container.remove(); }
});
