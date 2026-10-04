// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import App from "./App";
import { api, ApiError, expireSession, PasswordChangeRequiredError, requirePasswordChange, SessionExpiredError } from "./api";
import { setLanguage } from "./i18n";

vi.mock("./api", async (original) => ({ ...await original<object>(), api: vi.fn() }));
vi.mock("./pages/Settings", () => ({ Settings: () => <h1>Settings page</h1> }));
vi.mock("./pages/Administration", () => ({ Admin: () => <h1>Administration page</h1> }));
afterEach(() => { vi.resetAllMocks(); setLanguage("en"); window.history.replaceState({}, "", "/"); });

it("keeps collections available across pages and returns to the chosen collection without background subscription polling", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers();
  const collections = ["Films", "Books"].map((name) => ({ id: name.toLowerCase(), name, subscriptionCount: 0, unreadCount: 0, activityCount: 0 }));
  vi.mocked(api).mockImplementation(async (path) => {
    if (path === "/api/auth/me") return { user: { id: "admin", username: "admin", isAdmin: true, mustChangePassword: false, language: "en", trackerMarkerStyle: "icons", paginationEnabled: false, pageSize: 20, theme: "sentinel" } };
    if (path === "/api/system/status") return { scheduler: { running: false }, intervalMinutes: 30 };
    if (path === "/api/collections") return { collections };
    if (path.startsWith("/api/subscriptions?")) return { subscriptions: [] };
    throw new Error(`Unexpected request: ${path}`);
  });
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  const nav = (href: string) => container.querySelector<HTMLAnchorElement>(`.app-nav a[href="${href}"]`)!;
  const monitor = () => container.querySelector<HTMLAnchorElement>('.app-nav a[aria-label="Monitor"]')!;
  const collection = (name: string) => [...container.querySelectorAll<HTMLAnchorElement>(".collection-navigation--desktop .collection-item")].find((link) => link.textContent?.includes(name))!;
  try {
    await act(async () => root.render(<App />));
    expect(container.querySelector(".workspace .collection-rail")).toBeNull();
    expect(container.querySelectorAll(".collection-navigation--mobile .collection-item")).toHaveLength(2);
    expect(container.querySelector(".collection-switcher")).toBeNull();
    await act(async () => collection("Books").click());
    expect(container.querySelector("h1")?.textContent).toBe("Books");
    await act(async () => nav("/settings").click());
    expect(container.querySelector("h1")?.textContent).toBe("Settings page");
    expect(container.querySelector(".collection-navigation--mobile")).toBeNull();
    const toggle = container.querySelector<HTMLButtonElement>(".collection-switcher__toggle")!;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.textContent).toBe("Collections·Books");
    await act(async () => toggle.click());
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const strip = container.querySelector(".collection-navigation--mobile")!;
    expect(strip.id).toBe(toggle.getAttribute("aria-controls"));
    expect(strip.querySelectorAll(".collection-item")).toHaveLength(2);
    await act(async () => toggle.click());
    expect(container.querySelector(".collection-navigation--mobile")).toBeNull();
    expect(container.querySelectorAll(".collection-navigation--desktop .collection-item")).toHaveLength(2);
    expect(container.querySelector(".collection-item--active")).toBeNull();
    const subscriptionRequests = () => vi.mocked(api).mock.calls.filter(([path]) => path.startsWith("/api/subscriptions?")).length;
    const previous = subscriptionRequests();
    await act(async () => vi.advanceTimersByTime(30_000));
    expect(subscriptionRequests()).toBe(previous);
    expect(monitor().getAttribute("href")).toBe("/collections/books");
    await act(async () => monitor().click());
    expect(container.querySelector("h1")?.textContent).toBe("Books");
    await act(async () => nav("/admin").click());
    expect(container.querySelector("h1")?.textContent).toBe("Administration page");
    expect(container.querySelector(".collection-switcher__toggle")?.getAttribute("aria-expanded")).toBe("false");
    await act(async () => container.querySelector<HTMLButtonElement>(".collection-switcher__toggle")!.click());
    await act(async () => [...container.querySelectorAll<HTMLAnchorElement>(".collection-navigation--switcher .collection-item")].find((link) => link.textContent?.includes("Films"))!.click());
    expect(window.location.pathname).toBe("/collections/films");
    expect(container.querySelector("h1")?.textContent).toBe("Films");
    expect(container.querySelector(".collection-switcher")).toBeNull();
    expect(container.querySelector(".collection-navigation--mobile .collection-item--active")?.textContent).toContain("Films");
    await act(async () => nav("/admin").click());
    await act(async () => collection("Books").click());
    expect(container.querySelector("h1")?.textContent).toBe("Books");
    await act(async () => nav("/settings").click());
    await act(async () => container.querySelector<HTMLButtonElement>('.collection-navigation--desktop button[aria-label="New collection"]')!.click());
    expect(document.querySelector(".drawer h2")?.textContent).toBe("New collection");
  } finally { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); }
});

it("returns to sign-in with one clear message when the session expires during background polling", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers();
  let expired = false;
  vi.mocked(api).mockImplementation(async (path) => {
    if (expired) { expireSession(); throw new SessionExpiredError(); }
    if (path === "/api/auth/me") return { user: { id: "u1", username: "alice", isAdmin: false, mustChangePassword: false, language: "en", trackerMarkerStyle: "icons", paginationEnabled: false, pageSize: 20, theme: "sentinel" } };
    if (path === "/api/system/status") return { scheduler: { running: false }, intervalMinutes: 30 };
    if (path === "/api/collections") return { collections: [{ id: "films", name: "Films", subscriptionCount: 0, unreadCount: 0, activityCount: 0 }] };
    if (path.startsWith("/api/subscriptions?")) return { subscriptions: [] };
    throw new Error(`Unexpected request: ${path}`);
  });
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<App />));
    expect(container.querySelector("h1")?.textContent).toBe("Films");
    expired = true;
    await act(async () => vi.advanceTimersByTime(30_000));
    expect(container.querySelector(".login-form")).not.toBeNull();
    expect(container.querySelector(".app-shell")).toBeNull();
    const toasts = [...container.querySelectorAll(".toast")];
    expect(toasts.map((toast) => toast.textContent)).toEqual(["Your session has expired. Sign in again."]);
    expect(container.querySelector<HTMLInputElement>('input[autocomplete="username"]')!.value).toBe("alice");
    expect(container.querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe("");
  } finally { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); }
});

it("switches to the password form when a request reports that the password must be changed", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers();
  let reset = false;
  const user = { id: "u1", username: "alice", isAdmin: false, mustChangePassword: false, language: "en", trackerMarkerStyle: "icons", paginationEnabled: false, pageSize: 20, theme: "sentinel" };
  vi.mocked(api).mockImplementation(async (path) => {
    if (path === "/api/auth/change-password") { reset = false; return { user }; }
    if (path === "/api/auth/logout") return {};
    if (reset) { requirePasswordChange(); throw new PasswordChangeRequiredError(); }
    if (path === "/api/auth/me") return { user };
    if (path === "/api/system/status") return { scheduler: { running: false }, intervalMinutes: 30 };
    if (path === "/api/collections") return { collections: [{ id: "films", name: "Films", subscriptionCount: 0, unreadCount: 0, activityCount: 0 }] };
    if (path.startsWith("/api/subscriptions?")) return { subscriptions: [] };
    throw new Error(`Unexpected request: ${path}`);
  });
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  const passwords = () => [...container.querySelectorAll<HTMLInputElement>('.password-panel input[type="password"]')];
  const type = (input: HTMLInputElement, value: string) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); };
  try {
    window.history.replaceState({}, "", "/settings");
    await act(async () => root.render(<App />));
    expect(container.querySelector("h1")?.textContent).toBe("Settings page");
    reset = true;
    await act(async () => vi.advanceTimersByTime(30_000));
    expect(container.querySelector(".app-shell")).toBeNull();
    expect(container.querySelector(".password-panel .eyebrow")?.textContent).toBe("Password change required");
    expect(container.querySelector(".password-panel h1")?.textContent).toBe("Choose a new password.");
    expect(container.querySelector(".password-panel label")?.textContent).toContain("Temporary password");
    expect([...container.querySelectorAll(".toast")].map((toast) => toast.textContent)).toEqual(["Choose a new password to continue."]);

    const [current, next, confirm] = passwords();
    await act(async () => { type(current, "temporary-1"); type(next, "new-password-1"); type(confirm, "new-password-1"); });
    await act(async () => container.querySelector<HTMLFormElement>(".password-panel form")!.requestSubmit());
    expect(vi.mocked(api)).toHaveBeenCalledWith("/api/auth/change-password", expect.objectContaining({ method: "POST" }));
    expect(container.querySelector("h1")?.textContent).toBe("Settings page");
    expect(window.location.pathname).toBe("/settings");

    reset = true;
    await act(async () => vi.advanceTimersByTime(30_000));
    await act(async () => container.querySelector<HTMLButtonElement>(".password-sign-out")!.click());
    expect(vi.mocked(api)).toHaveBeenCalledWith("/api/auth/logout", { method: "POST" });
    expect(container.querySelector(".login-form")).not.toBeNull();
    expect(container.querySelector<HTMLInputElement>('input[autocomplete="username"]')!.value).toBe("");
  } finally { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); }
});

it("shows sign-in without a session-expired message for a visitor who was never signed in", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.mocked(api).mockImplementation(async () => { expireSession(); throw new SessionExpiredError(); });
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<App />));
    expect(container.querySelector(".login-form")).not.toBeNull();
    expect(container.querySelector(".toast")).toBeNull();
    expect(container.querySelector<HTMLInputElement>('input[autocomplete="username"]')!.value).toBe("");
  } finally { await act(async () => root.unmount()); container.remove(); }
});

it("opens the account menu, closes it with Escape or an outside click, and signs out from it", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.mocked(api).mockImplementation(async (path) => {
    if (path === "/api/auth/me") return { user: { id: "admin", username: "admin", isAdmin: true, mustChangePassword: false, language: "en", trackerMarkerStyle: "icons", paginationEnabled: false, pageSize: 20, theme: "sentinel" } };
    if (path === "/api/system/status") return { scheduler: { running: false }, intervalMinutes: 30 };
    if (path === "/api/collections") return { collections: [] };
    if (path === "/api/auth/logout") return {};
    throw new Error(`Unexpected request: ${path}`);
  });
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  const menu = () => document.querySelector<HTMLElement>('[role="menu"]');
  const key = (target: Element, name: string) => target.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));
  try {
    await act(async () => root.render(<App />));
    const trigger = container.querySelector<HTMLButtonElement>(".account-button")!;
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.textContent).not.toContain("Sign out");
    await act(async () => trigger.click());
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(menu()?.getAttribute("aria-label")).toBe("Account");
    expect(trigger.getAttribute("aria-controls")).toBe(menu()!.id);
    expect(document.querySelector(".menu-popover__header")).toBeNull();
    const items = [...menu()!.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    expect(items.map((item) => item.textContent)).toEqual(["Change password", "Keyboard shortcuts", "Sign out"]);
    expect(document.activeElement).toBe(items[0]);
    await act(async () => key(items[0], "Escape"));
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    const mobile = container.querySelector<HTMLButtonElement>(".account-nav")!;
    expect(mobile.getAttribute("aria-label")).toBe("Account");
    await act(async () => key(mobile, "ArrowDown"));
    const mobileItems = [...menu()!.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    expect(mobileItems.map((item) => item.textContent)).toEqual(["Change password", "Keyboard shortcuts", "Sign out", expect.stringMatching(/^Torrentinel v\d/)]);
    expect(document.activeElement).toBe(mobileItems[0]);
    await act(async () => key(mobileItems[0], "ArrowDown"));
    expect(document.activeElement).toBe(mobileItems[1]);
    expect(menu()!.parentElement!.textContent).toContain("admin");
    expect(menu()!.parentElement!.textContent).toContain("Monitor ready");
    await act(async () => document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })));
    expect(menu()).toBeNull();

    await act(async () => trigger.click());
    await act(async () => [...menu()!.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent === "Sign out")!.click());
    expect(vi.mocked(api)).toHaveBeenCalledWith("/api/auth/logout", { method: "POST" });
    expect(container.querySelector(".login-form")).not.toBeNull();
    expect(menu()).toBeNull();
  } finally { await act(async () => root.unmount()); container.remove(); }
});

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return { get length() { return values.size; }, clear: () => values.clear(), getItem: (key) => values.get(key) ?? null, key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); }, setItem: (key, value) => { values.set(key, String(value)); } };
}
function mockMonitor(options: { paginationEnabled?: boolean; unread?: number } = {}) {
  const collections = ["Films", "Books"].map((name) => ({ id: name.toLowerCase(), name, subscriptionCount: 60, unreadCount: options.unread ?? 0, activityCount: options.unread ?? 0 }));
  vi.mocked(api).mockImplementation(async (path) => {
    if (path === "/api/auth/me") return { user: { id: "admin", username: "admin", isAdmin: true, mustChangePassword: false, language: "en", trackerMarkerStyle: "icons", paginationEnabled: options.paginationEnabled ?? true, pageSize: 20, theme: "sentinel" } };
    if (path === "/api/system/status") return { scheduler: { running: false }, intervalMinutes: 30 };
    if (path === "/api/collections") return { collections };
    if (path.startsWith("/api/activity?")) return { events: [], total: 0, page: 1, pageCount: 1 };
    if (path.startsWith("/api/subscriptions?")) {
      const page = Number(new URL(path, "http://test").searchParams.get("page") || "1");
      return { subscriptions: [], total: 60, page: Math.min(page, 3), pageCount: 3 };
    }
    throw new Error(`Unexpected request: ${path}`);
  });
}
const lastSubscriptionQuery = () => new URL(vi.mocked(api).mock.calls.filter(([path]) => path.startsWith("/api/subscriptions?")).at(-1)![0], "http://test").searchParams;
const popState = (move: () => void) => act(() => new Promise<void>((resolve) => { window.addEventListener("popstate", () => resolve(), { once: true }); move(); }));
const currentUrl = () => window.location.pathname + window.location.search;

it("restores the collection, filter, search, page and sort from the URL, including after reload and back/forward", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  mockMonitor();
  window.history.replaceState({}, "", "/collections/books?filter=unread&page=2&sort=name");
  const container = document.createElement("div"); document.body.append(container);
  let root = createRoot(container);
  const filterTab = (label: string) => [...container.querySelectorAll<HTMLButtonElement>(".filter-tabs button")].find((button) => button.querySelector(".filter-tabs__label")?.textContent === label)!;
  const sort = () => container.querySelector<HTMLSelectElement>('select[aria-label="Sort"]')!;
  const search = () => container.querySelector<HTMLInputElement>('input[aria-label="Filter this collection"]')!;
  try {
    await act(async () => root.render(<App />));
    const expectView = (filter: string, page: string, sortValue: string, query = "") => {
      expect(container.querySelector("h1")?.textContent).toBe("Books");
      expect(container.querySelector(".filter-tabs .active .filter-tabs__label")?.textContent).toBe(filter);
      expect(container.querySelector(".pagination--top")?.textContent).toContain(`Page ${page} of 3`);
      expect(sort().value).toBe(sortValue); expect(search().value).toBe(query);
      expect(Object.fromEntries(lastSubscriptionQuery())).toMatchObject({ collectionId: "books", filter: filter.toLowerCase(), page, search: query, ...sortValue === "changed" ? {} : { sort: sortValue } });
    };
    expectView("Unread", "2", "name");
    expect(currentUrl()).toBe("/collections/books?filter=unread&page=2&sort=name");
    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => root.render(<App />));
    expectView("Unread", "2", "name");

    const start = window.history.length;
    await act(async () => filterTab("Errors").click());
    expect(currentUrl()).toBe("/collections/books?filter=errors&sort=name");
    await act(async () => container.querySelector<HTMLButtonElement>('.pagination--top button[aria-label="Next page"]')!.click());
    expect(currentUrl()).toBe("/collections/books?filter=errors&page=2&sort=name");
    await act(async () => { sort().value = "attention"; sort().dispatchEvent(new Event("change", { bubbles: true })); });
    expect(currentUrl()).toBe("/collections/books?filter=errors&sort=attention");
    expect(window.history.length).toBe(start + 3);
    const type = async (value: string) => {
      await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search(), value); search().dispatchEvent(new Event("input", { bubbles: true })); });
      await act(() => new Promise((resolve) => window.setTimeout(resolve, 300)));
    };
    await type("du"); await type("dune 2");
    expect(currentUrl()).toBe("/collections/books?filter=errors&q=dune+2&sort=attention");
    expect(lastSubscriptionQuery().get("search")).toBe("dune 2");
    expect(window.history.length).toBe(start + 3);

    await popState(() => window.history.back());
    expect(currentUrl()).toBe("/collections/books?filter=errors&page=2&sort=name");
    expectView("Errors", "2", "name");
    await popState(() => window.history.go(-2));
    expectView("Unread", "2", "name");
    await popState(() => window.history.forward());
    expect(currentUrl()).toBe("/collections/books?filter=errors&sort=name");
    expectView("Errors", "1", "name");

    // Collection links keep the filter, search and sort but start on the first page.
    const films = [...container.querySelectorAll<HTMLAnchorElement>(".collection-navigation--desktop .collection-item")].find((link) => link.textContent?.includes("Films"))!;
    expect(films.getAttribute("href")).toBe("/collections/films?filter=errors&sort=name");
    await act(async () => films.click());
    expect(container.querySelector("h1")?.textContent).toBe("Films");
    expect(currentUrl()).toBe("/collections/films?filter=errors&sort=name");
    expect(lastSubscriptionQuery().get("collectionId")).toBe("films");
  } finally { await act(async () => root.unmount()); container.remove(); }
});

it("resolves / and unknown collections to the last used or first collection without adding history entries", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal("localStorage", memoryStorage());
  mockMonitor({ paginationEnabled: false });
  const container = document.createElement("div"); document.body.append(container);
  let root = createRoot(container);
  try {
    localStorage.setItem("torrentinel-last-collection:admin", "books");
    const start = window.history.length;
    await act(async () => root.render(<App />));
    expect(currentUrl()).toBe("/collections/books");
    expect(container.querySelector("h1")?.textContent).toBe("Books");
    expect(window.history.length).toBe(start);

    await act(async () => root.unmount());
    localStorage.clear();
    window.history.replaceState({}, "", "/collections/deleted?filter=unread&page=4");
    root = createRoot(container);
    await act(async () => root.render(<App />));
    expect(currentUrl()).toBe("/collections/films?filter=unread");
    expect(container.querySelector("h1")?.textContent).toBe("Films");
    expect(localStorage.getItem("torrentinel-last-collection:admin")).toBe("films");
    expect(window.history.length).toBe(start);
    expect(vi.mocked(api).mock.calls.filter(([path]) => path.includes("collectionId=deleted")).length).toBeLessThanOrEqual(1);
    expect(lastSubscriptionQuery().get("collectionId")).toBe("films");
  } finally { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); }
});

it("adds an Activity view with the total unread count and keeps Monitor one click away", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  mockMonitor({ paginationEnabled: false, unread: 2 });
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  const link = (label: string) => container.querySelector<HTMLAnchorElement>(`.app-nav a[aria-label^="${label}"]`)!;
  try {
    await act(async () => root.render(<App />));
    const activity = link("Activity");
    expect(activity.getAttribute("href")).toBe("/activity");
    expect(activity.getAttribute("aria-label")).toBe("Activity, 4 unread");
    expect(activity.querySelector(".nav-badge")?.textContent).toBe("4");
    expect([...container.querySelectorAll(".app-nav > nav:first-of-type a")].map((item) => item.getAttribute("aria-label"))).toEqual(["Monitor", "Activity, 4 unread"]);
    await act(async () => activity.click());
    expect(currentUrl()).toBe("/activity");
    expect(container.querySelector("h1")?.textContent).toBe("Activity");
    expect(link("Activity").getAttribute("aria-current")).toBe("page");
    expect(container.querySelector(".collection-switcher__current")?.textContent).toBe("Films");
    expect(vi.mocked(api)).toHaveBeenCalledWith("/api/activity?filter=unread&page=1&pageSize=20", expect.anything());
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>(".filter-tabs button")].find((button) => button.textContent === "All")!.click());
    expect(currentUrl()).toBe("/activity?filter=all");
    await popState(() => window.history.back());
    expect(container.querySelector(".filter-tabs .active .filter-tabs__label")?.textContent).toBe("Unread");
    await act(async () => link("Monitor").click());
    expect(currentUrl()).toBe("/collections/films");
    expect(container.querySelector("h1")?.textContent).toBe("Films");
  } finally { await act(async () => root.unmount()); container.remove(); }
});

it("scrolls to the top for another page, keeps the position for filter changes, and restores it on Back/Forward", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  mockMonitor({ paginationEnabled: false });
  window.history.replaceState({}, "", "/collections/films");
  let y = 640;
  Object.defineProperty(window, "scrollY", { configurable: true, get: () => y });
  const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(((x: number, top: number) => { y = top; }) as typeof window.scrollTo);
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  const nav = (label: string) => container.querySelector<HTMLAnchorElement>(`.app-nav a[aria-label^="${label}"]`)!;
  try {
    await act(async () => root.render(<App />));
    expect(scrollTo).not.toHaveBeenCalled();
    expect(window.history.scrollRestoration).toBe("manual");
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>(".filter-tabs button")][1].click());
    expect(currentUrl()).toBe("/collections/films?filter=unread");
    expect(scrollTo).not.toHaveBeenCalled();
    await act(async () => nav("Settings").click());
    expect(scrollTo).toHaveBeenLastCalledWith(0, 0);
    y = 300;
    await act(async () => nav("Activity").click());
    expect(scrollTo).toHaveBeenLastCalledWith(0, 0);
    const pageChanges = scrollTo.mock.calls.length;
    await popState(() => window.history.back());
    expect(currentUrl()).toBe("/settings");
    expect(scrollTo).toHaveBeenLastCalledWith(0, 300);
    await popState(() => window.history.back());
    expect(currentUrl()).toBe("/collections/films?filter=unread");
    expect(scrollTo).toHaveBeenLastCalledWith(0, 640);
    expect(scrollTo.mock.calls.length).toBeGreaterThan(pageChanges);
  } finally { await act(async () => root.unmount()); container.remove(); scrollTo.mockRestore(); Reflect.deleteProperty(window, "scrollY"); }
});

it("rewrites a stale /admin address reached with Back/Forward to the member's Monitor URL", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  mockMonitor({ paginationEnabled: false });
  const member = { id: "member", username: "maria", isAdmin: false, mustChangePassword: false, language: "en", trackerMarkerStyle: "icons", paginationEnabled: false, pageSize: 20, theme: "sentinel" };
  const base = vi.mocked(api).getMockImplementation()!;
  vi.mocked(api).mockImplementation(async (path, init) => path === "/api/auth/me" ? { user: member } : base(path, init));
  window.history.replaceState({}, "", "/collections/books");
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<App />));
    expect(container.querySelector("h1")?.textContent).toBe("Books");
    window.history.pushState({}, "", "/admin/users?x=1");
    const length = window.history.length;
    await act(async () => window.dispatchEvent(new PopStateEvent("popstate")));
    expect(currentUrl()).toBe("/collections/books");
    expect(window.history.length).toBe(length);
    expect(container.querySelector("h1")?.textContent).toBe("Books");
    expect(vi.mocked(api).mock.calls.some(([path]) => path.startsWith("/api/admin/"))).toBe(false);
  } finally { await act(async () => root.unmount()); container.remove(); }
});

it("opens an accessible keyboard shortcuts dialog with ? on Monitor and Activity or from the account menu, but not with ? on Settings", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  mockMonitor({ paginationEnabled: false });
  window.history.replaceState({}, "", "/collections/films");
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  const dialog = () => document.querySelector<HTMLElement>('.shortcuts-dialog[role="dialog"]');
  const press = (key: string, target: Element = document.activeElement ?? document.body) => act(async () => { target.dispatchEvent(new KeyboardEvent("keydown", { key, shiftKey: key === "?", bubbles: true, cancelable: true })); });
  const frame = () => act(() => new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve())));
  try {
    await act(async () => root.render(<App />));
    await press("?");
    expect(dialog()?.getAttribute("aria-modal")).toBe("true");
    expect(document.getElementById(dialog()!.getAttribute("aria-labelledby")!)?.textContent).toBe("Keyboard shortcuts");
    expect([...dialog()!.querySelectorAll(".shortcut-list kbd")].map((key) => key.textContent)).toEqual(["/", "j", "k", "Enter", "a", "?", "Esc"]);
    await frame();
    expect(document.activeElement?.textContent).toBe("Close");
    // A second ? is ignored while the dialog is open; Escape closes it.
    await press("?");
    expect(document.querySelectorAll(".shortcuts-dialog")).toHaveLength(1);
    await press("Escape");
    expect(dialog()).toBeNull();

    await act(async () => container.querySelector<HTMLAnchorElement>('.app-nav a[aria-label^="Activity"]')!.click());
    await press("?", document.body);
    expect(dialog()).not.toBeNull();
    await act(async () => dialog()!.querySelector<HTMLButtonElement>(".app-dialog__actions button")!.click());
    expect(dialog()).toBeNull();

    await act(async () => container.querySelector<HTMLAnchorElement>('.app-nav a[aria-label="Settings"]')!.click());
    await press("?", document.body);
    expect(dialog()).toBeNull();
    const trigger = container.querySelector<HTMLButtonElement>(".account-button")!;
    await act(async () => trigger.click());
    await act(async () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent === "Keyboard shortcuts")!.click());
    expect(dialog()).not.toBeNull();
    await act(async () => dialog()!.querySelector<HTMLButtonElement>('button[aria-label="Close dialog"]')!.click());
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(trigger);

    await act(async () => setLanguage("ru"));
    await act(async () => trigger.click());
    expect([...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent)).toContain("Горячие клавиши");
  } finally { await act(async () => root.unmount()); container.remove(); }
});

it("keeps sign-in errors until dismissed or replaced by signing in, and lifts the stack above the mobile navigation in the app", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  let attempts = 0;
  const user = { id: "admin", username: "admin", isAdmin: true, mustChangePassword: false, language: "en", trackerMarkerStyle: "icons", paginationEnabled: false, pageSize: 20, theme: "sentinel" };
  vi.mocked(api).mockImplementation(async (path) => {
    if (path === "/api/auth/me") throw new ApiError("Authentication required", 401);
    if (path === "/api/auth/login") { if (++attempts < 3) throw new ApiError("Invalid username or password", 401); return { user }; }
    if (path === "/api/system/status") return { scheduler: { running: false }, intervalMinutes: 30 };
    if (path === "/api/collections") return { collections: [] };
    throw new Error(`Unexpected request: ${path}`);
  });
  vi.useFakeTimers();
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  const toasts = () => [...container.querySelectorAll(".toast")].map((toast) => toast.textContent);
  const submit = () => act(async () => container.querySelector<HTMLFormElement>(".login-form")!.requestSubmit());
  try {
    await act(async () => root.render(<App />));
    expect(container.querySelector(".toast-stack--navigation")).toBeNull();
    const fill = (selector: string, value: string) => { const input = container.querySelector<HTMLInputElement>(selector)!; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); };
    await act(async () => { fill('input[autocomplete="username"]', "admin"); fill('input[type="password"]', "wrong"); });
    await submit();
    expect(toasts()).toEqual(["Invalid username or password"]);
    expect(container.querySelector('[role="alert"] .toast')).not.toBeNull();
    await act(async () => vi.advanceTimersByTime(60_000));
    expect(toasts()).toEqual(["Invalid username or password"]);
    await act(async () => container.querySelector<HTMLButtonElement>('.toast button[aria-label="Dismiss notification"]')!.click());
    expect(toasts()).toEqual([]);
    await submit();
    expect(toasts()).toEqual(["Invalid username or password"]);
    await submit();
    expect(container.querySelector(".app-shell")).not.toBeNull();
    expect(toasts()).toEqual([]);
    expect(container.querySelector(".toast-stack--navigation")).not.toBeNull();
  } finally { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); }
});
