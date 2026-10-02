// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import App from "./App";
import { api } from "./api";
import { setLanguage } from "./i18n";

vi.mock("./api", async (original) => ({ ...await original<object>(), api: vi.fn() }));
vi.mock("./pages/Settings", () => ({ Settings: () => <h1>Settings page</h1> }));
vi.mock("./pages/Administration", () => ({ Admin: () => <h1>Administration page</h1> }));
afterEach(() => { vi.resetAllMocks(); setLanguage("en"); window.history.replaceState({}, "", "/"); });

it("keeps collections available across pages and returns to the chosen collection without background subscription polling", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers();
  const collections = ["Films", "Books"].map((name) => ({ id: name.toLowerCase(), name, subscriptionCount: 0, unreadCount: 0 }));
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
  const collection = (name: string) => [...container.querySelectorAll<HTMLButtonElement>(".collection-navigation--desktop .collection-item")].find((button) => button.textContent?.includes(name))!;
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
    await act(async () => nav("/").click());
    expect(container.querySelector("h1")?.textContent).toBe("Books");
    await act(async () => nav("/admin").click());
    expect(container.querySelector("h1")?.textContent).toBe("Administration page");
    expect(container.querySelector(".collection-switcher__toggle")?.getAttribute("aria-expanded")).toBe("false");
    await act(async () => container.querySelector<HTMLButtonElement>(".collection-switcher__toggle")!.click());
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>(".collection-navigation--switcher .collection-item")].find((button) => button.textContent?.includes("Films"))!.click());
    expect(window.location.pathname).toBe("/");
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
    expect(items.map((item) => item.textContent)).toEqual(["Sign out"]);
    expect(document.activeElement).toBe(items[0]);
    await act(async () => key(items[0], "Escape"));
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    const mobile = container.querySelector<HTMLButtonElement>(".account-nav")!;
    expect(mobile.getAttribute("aria-label")).toBe("Account");
    await act(async () => key(mobile, "ArrowDown"));
    const mobileItems = [...menu()!.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    expect(mobileItems.map((item) => item.textContent)).toEqual(["Sign out", expect.stringMatching(/^Torrentinel v\d/)]);
    expect(document.activeElement).toBe(mobileItems[0]);
    await act(async () => key(mobileItems[0], "ArrowDown"));
    expect(document.activeElement).toBe(mobileItems[1]);
    expect(menu()!.parentElement!.textContent).toContain("admin");
    expect(menu()!.parentElement!.textContent).toContain("Monitor ready");
    await act(async () => document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })));
    expect(menu()).toBeNull();

    await act(async () => trigger.click());
    await act(async () => menu()!.querySelector<HTMLElement>('[role="menuitem"]')!.click());
    expect(vi.mocked(api)).toHaveBeenCalledWith("/api/auth/logout", { method: "POST" });
    expect(container.querySelector(".login-form")).not.toBeNull();
    expect(menu()).toBeNull();
  } finally { await act(async () => root.unmount()); container.remove(); }
});
