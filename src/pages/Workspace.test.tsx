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
  const user: User = { id: "user", username: "test", isAdmin: false, mustChangePassword: false, trackerMarkerStyle: "icons", language: "en", paginationEnabled: true, pageSize: 20, theme: "sentinel" };
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
  const user: User = { id: "user", username: "test", isAdmin: false, mustChangePassword: false, trackerMarkerStyle: "icons", language: "en", paginationEnabled: false, pageSize: 20, theme: "sentinel" };
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
    // Russian labels stay short enough for the phone toolbar; the column shares the date label.
    await act(async () => setLanguage("ru"));
    expect([...sort.options].map((option) => option.textContent)).toEqual(["Дата изменения", "Название (А–Я)", "Сначала ошибки"]);
    expect(container.querySelector<HTMLInputElement>(".search-box input")?.placeholder).toBe("Поиск");
    expect(container.querySelectorAll(".subscription-head span")[2]?.textContent).toBe("Дата изменения");
  } finally { await act(async () => root.unmount()); container.remove(); }
});

it("marks a collection read after confirming, from the header or the more-actions menu", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const user: User = { id: "user", username: "test", isAdmin: false, mustChangePassword: false, trackerMarkerStyle: "icons", language: "en", paginationEnabled: false, pageSize: 20, theme: "sentinel" };
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
    expect(menuItems().map((item) => item.textContent)).toEqual(["Mark all read", "Rename collection", "Delete collection"]);
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
    expect(menuItems().map((item) => item.textContent)).toEqual(["Rename collection", "Delete collection"]);
  } finally { await act(async () => root.unmount()); container.remove(); }
});

it("renames and deletes the collection from the more-actions menu", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const user: User = { id: "user", username: "test", isAdmin: false, mustChangePassword: false, trackerMarkerStyle: "icons", language: "en", paginationEnabled: false, pageSize: 20, theme: "sentinel" };
  vi.mocked(api).mockImplementation(async (path) => {
    if (path === "/api/collections") return { collections: [{ id: "inbox", name: "Inbox", subscriptionCount: 0, unreadCount: 0 }] };
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
  try {
    await act(async () => root.render(<Harness />));
    expect(container.querySelector('.header-action[aria-label="Rename collection"]')).not.toBeNull();
    expect(container.querySelector('.header-action[aria-label="Delete collection"]')).not.toBeNull();
    expect(more().getAttribute("aria-label")).toBe("Collection actions");
    await act(async () => more().click());
    expect(document.querySelector('[role="menu"]')?.getAttribute("aria-label")).toBe("Collection actions");
    await act(async () => choose("Rename collection").click());
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(container.querySelector(".app-dialog h2")?.textContent).toBe("Rename collection");
    const input = container.querySelector<HTMLInputElement>(".app-dialog input")!;
    expect(input.value).toBe("Inbox");
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Watchlist"); input.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => submitDialog());
    expect(vi.mocked(api)).toHaveBeenCalledWith("/api/collections/inbox", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ name: "Watchlist" }) }));
    expect(notify).toHaveBeenCalledWith("Collection renamed");

    await act(async () => more().click());
    await act(async () => choose("Delete collection").click());
    expect(container.querySelector(".app-dialog h2")?.textContent).toBe("Delete “Inbox”?");
    await act(async () => submitDialog());
    expect(vi.mocked(api)).toHaveBeenCalledWith("/api/collections/inbox", { method: "DELETE" });
    expect(notify).toHaveBeenCalledWith("Collection deleted");
  } finally { await act(async () => root.unmount()); container.remove(); }
});
