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
    await act(async () => collection("Books").click());
    expect(container.querySelector("h1")?.textContent).toBe("Books");
    await act(async () => nav("/settings").click());
    expect(container.querySelector("h1")?.textContent).toBe("Settings page");
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
    await act(async () => collection("Films").click());
    expect(window.location.pathname).toBe("/");
    expect(container.querySelector("h1")?.textContent).toBe("Films");
    await act(async () => nav("/settings").click());
    await act(async () => container.querySelector<HTMLButtonElement>('.collection-navigation--desktop button[aria-label="New collection"]')!.click());
    expect(document.querySelector(".drawer h2")?.textContent).toBe("New collection");
  } finally { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); }
});
