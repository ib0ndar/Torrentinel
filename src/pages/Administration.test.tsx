// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import App from "../App";
import { api } from "../api";
import { setLanguage } from "../i18n";

vi.mock("../api", async (original) => ({ ...await original<object>(), api: vi.fn() }));
afterEach(() => { vi.resetAllMocks(); setLanguage("en"); window.history.replaceState({}, "", "/"); });

const TRACKERS = ["kinozal", "rutor", "rutracker"] as const;
const TRACKER_NAMES = { kinozal: "Kinozal", rutor: "Rutor", rutracker: "RuTracker" };
const observations = Array.from({ length: 45 }, (_, index) => ({ id: `o${index}`, runId: "run", subscriptionId: index % 2 ? "r1" : null, subscriptionName: index % 2 ? "Dune + 2160p" : null, username: "admin",
  trackerKey: TRACKERS[index % 3], operation: "direct", outcome: index % 2 ? "error" : "unchanged", durationMs: 10, details: {}, title: `Observation ${index}`, observedAt: new Date(Date.now() - index * 60_000).toISOString() }));
const deliveries = Array.from({ length: 25 }, (_, index) => ({ id: `t${index}`, subscriptionId: "d1", subscriptionName: "Current release", username: "admin", trackerKey: "rutor", externalId: String(index),
  title: `Delivery ${index}`, deliveryMethod: "text", outcome: "delivered", telegramMessageId: index + 1, durationMs: 20, createdAt: new Date(Date.now() - index * 60_000).toISOString() }));
const queue = [{ id: "q1", username: "admin", subscriptionId: "r1", subscriptionName: "Dune + 2160p", attempts: 1, nextAttemptAt: new Date(Date.now() + 60_000).toISOString(), status: "pending" },
  { id: "q2", username: "member", subscriptionId: "77", subscriptionName: null, attempts: 3, nextAttemptAt: new Date(Date.now() + 60_000).toISOString(), lastError: "Telegram unavailable", status: "pending" }];
function page<T>(rows: T[], query: URLSearchParams) {
  const pageSize = Number(query.get("pageSize")), total = rows.length, pageCount = Math.max(1, Math.ceil(total / pageSize)), current = Math.min(Number(query.get("page")), pageCount);
  return { rows: rows.slice((current - 1) * pageSize, current * pageSize), total, page: current, pageSize, pageCount };
}
function mockAdmin(options: { isAdmin?: boolean } = {}) {
  let mirrors = [{ trackerKey: "kinozal", displayName: "Kinozal", baseUrl: "https://kinozal.tv", enabled: true, updatedAt: "2026-10-01T00:00:00.000Z" },
    { trackerKey: "rutor", displayName: "Rutor", baseUrl: "https://rutor.is", enabled: true, updatedAt: "2026-10-01T00:00:00.000Z" }];
  vi.mocked(api).mockImplementation(async (path, init) => {
    const url = new URL(path, "http://test"), query = url.searchParams;
    if (path === "/api/auth/me") return { user: { id: "admin", username: "admin", isAdmin: options.isAdmin ?? true, mustChangePassword: false, language: "en", trackerMarkerStyle: "icons", paginationEnabled: false, pageSize: 20, theme: "sentinel" } };
    if (path === "/api/system/status") return { scheduler: { running: false, checked: 4, changed: 1, errors: 0 }, intervalMinutes: 30, discoveryHealth: [] };
    if (path === "/api/collections") return { collections: [{ id: "films", name: "Films", subscriptionCount: 0, unreadCount: 0, activityCount: 0 }] };
    if (path.startsWith("/api/subscriptions?")) return { subscriptions: [] };
    if (path === "/api/admin/users") return { users: [{ id: "admin", username: "admin", isAdmin: true, disabled: false, mustChangePassword: false, collectionCount: 1, subscriptionCount: 3, createdAt: "2026-09-01T00:00:00.000Z" },
      { id: "member", username: "member", isAdmin: false, disabled: false, mustChangePassword: true, collectionCount: 1, subscriptionCount: 0, createdAt: "2026-09-02T00:00:00.000Z" }] };
    if (path === "/api/trackers") return { trackers: TRACKERS.map((key) => ({ key, displayName: TRACKER_NAMES[key], hosts: [], snapshotVersion: 1, capabilities: { authentication: "none", customMirrors: true, direct: true, rules: true, covers: true } })) };
    if (path === "/api/admin/mirrors") return { mirrors };
    if (url.pathname.startsWith("/api/admin/mirrors/") && init?.method === "PUT") {
      const body = JSON.parse(String(init.body)) as { baseUrl: string; enabled: boolean }, key = url.pathname.split("/").at(-1);
      mirrors = mirrors.map((mirror) => mirror.trackerKey === key ? { ...mirror, baseUrl: new URL(body.baseUrl).origin, enabled: body.enabled } : mirror);
      return { ok: true };
    }
    if (path === "/api/admin/diagnostics/queue") return { notificationQueue: queue };
    if (url.pathname === "/api/admin/diagnostics/observations") {
      const matching = observations.filter((row) => (!query.get("trackerKey") || row.trackerKey === query.get("trackerKey")) && (!query.get("outcome") || row.outcome === query.get("outcome")));
      const { rows, ...paging } = page(matching, query);
      return { retentionHours: 168, observations: rows, outcomes: ["error", "unchanged"], ...paging };
    }
    if (url.pathname === "/api/admin/diagnostics/deliveries") { const { rows, ...paging } = page(deliveries, query); return { retentionHours: 168, telegramDeliveries: rows, ...paging }; }
    throw new Error(`Unexpected request: ${path}`);
  });
}
const currentUrl = () => window.location.pathname + window.location.search;
const popState = (move: () => void) => act(() => new Promise<void>((resolve) => { window.addEventListener("popstate", () => resolve(), { once: true }); move(); }));
const type = (input: HTMLInputElement, value: string) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); };
const choose = (select: HTMLSelectElement, value: string) => { select.value = value; select.dispatchEvent(new Event("change", { bubbles: true })); };
const lastQuery = (pathname: string) => new URL(vi.mocked(api).mock.calls.filter(([path]) => path.startsWith(pathname)).at(-1)![0], "http://test").searchParams;
async function renderApp(path: string): Promise<{ container: HTMLDivElement; root: Root; cleanup: () => Promise<void> }> {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  window.history.replaceState({}, "", path);
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<App />));
  return { container, root, cleanup: async () => { await act(async () => root.unmount()); container.remove(); } };
}

it("resolves /admin to Overview in place and switches sections with tab links while Administration stays active", async () => {
  mockAdmin();
  const start = window.history.length;
  const { container, cleanup } = await renderApp("/admin");
  const tabs = () => [...container.querySelectorAll<HTMLAnchorElement>('nav[aria-label="Administration sections"] a')];
  const current = () => tabs().filter((tab) => tab.getAttribute("aria-current") === "page").map((tab) => tab.textContent);
  const sidebar = () => container.querySelector<HTMLAnchorElement>('.app-nav a[aria-label="Administration"]')!;
  try {
    expect(currentUrl()).toBe("/admin/overview");
    expect(window.history.length).toBe(start);
    expect(container.querySelector('[role="tablist"]')).toBeNull();
    expect(tabs().map((tab) => [tab.textContent, tab.getAttribute("href")])).toEqual([["Overview", "/admin/overview"], ["Users", "/admin/users"], ["Mirrors", "/admin/mirrors"], ["Diagnostics", "/admin/diagnostics"]]);
    expect(current()).toEqual(["Overview"]);
    expect(sidebar().getAttribute("aria-current")).toBe("page");
    expect(container.textContent).toContain("Polling interval");
    expect(container.textContent).not.toContain("New user");

    await act(async () => tabs()[1].click());
    expect(currentUrl()).toBe("/admin/users");
    expect(window.history.length).toBe(start + 1);
    expect(current()).toEqual(["Users"]);
    expect(sidebar().getAttribute("aria-current")).toBe("page");
    expect([...container.querySelectorAll(".user-table .table-row strong")].map((cell) => cell.textContent)).toEqual(["admin", "member"]);
    expect(container.querySelector(".page-header .button--primary")?.textContent).toBe("New user");
    expect(container.textContent).not.toContain("Polling interval");

    await act(async () => tabs()[2].click());
    expect(current()).toEqual(["Mirrors"]);
    expect(container.querySelectorAll(".mirror-row")).toHaveLength(2);
    // A modified click keeps the browser's own link behaviour (new tab), so the page does not change.
    const blockBrowserNavigation = (event: Event) => event.preventDefault(); // jsdom cannot open links
    window.addEventListener("click", blockBrowserNavigation);
    await act(async () => { tabs()[3].dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true })); });
    window.removeEventListener("click", blockBrowserNavigation);
    expect(currentUrl()).toBe("/admin/mirrors");
    await popState(() => window.history.back());
    expect(currentUrl()).toBe("/admin/users");
    expect(current()).toEqual(["Users"]);
    expect(sidebar().getAttribute("aria-current")).toBe("page");
  } finally { await cleanup(); }

  const unknown = await renderApp("/admin/bogus?x=1");
  try {
    expect(currentUrl()).toBe("/admin/overview");
    expect(unknown.container.querySelector('nav[aria-label="Administration sections"] a[aria-current="page"]')?.textContent).toBe("Overview");
  } finally { await unknown.cleanup(); }
});

it("keeps members out of every Administration section", async () => {
  mockAdmin({ isAdmin: false });
  const { container, cleanup } = await renderApp("/admin/diagnostics?page=2");
  try {
    expect(currentUrl()).toBe("/collections/films");
    expect(container.querySelector("h1")?.textContent).toBe("Films");
    expect(container.querySelector('.app-nav a[aria-label="Administration"]')).toBeNull();
    expect(vi.mocked(api).mock.calls.some(([path]) => path.startsWith("/api/admin/"))).toBe(false);
  } finally { await cleanup(); }
});

it("pages tracker logs and Telegram deliveries on the server and keeps filters and pages in the address", async () => {
  mockAdmin();
  let app = await renderApp("/admin/diagnostics?outcome=error&page=2");
  const logs = () => [...app.container.querySelectorAll<HTMLElement>(".diagnostic-section")][1];
  const telegram = () => [...app.container.querySelectorAll<HTMLElement>(".diagnostic-section")][2];
  const select = (label: string) => app.container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
  const pageButton = (section: HTMLElement, label: string, position = 0) => section.querySelectorAll<HTMLButtonElement>(`button[aria-label="${label}"]`)[position];
  try {
    // A deep link (or reload) restores the filter and page.
    expect(currentUrl()).toBe("/admin/diagnostics?outcome=error&page=2");
    expect(Object.fromEntries(lastQuery("/api/admin/diagnostics/observations"))).toEqual({ page: "2", pageSize: "20", outcome: "error" });
    expect(select("Filter logs by tracker").value).toBe("");
    // Tracker choices and names come from GET /api/trackers.
    expect([...select("Filter logs by tracker").options].map((option) => [option.value, option.textContent])).toEqual([["", "All trackers"], ["kinozal", "Kinozal"], ["rutor", "Rutor"], ["rutracker", "RuTracker"]]);
    expect(logs().querySelector(".diagnostic-row .diagnostic-source strong")?.textContent).toBe("RuTracker");
    expect(app.container.querySelector(".toast")).toBeNull();
    expect(select("Filter logs by outcome").value).toBe("error");
    expect([...select("Filter logs by outcome").options].map((option) => option.value)).toEqual(["", "error", "unchanged"]);
    expect(logs().querySelectorAll(".diagnostic-row")).toHaveLength(2);
    expect(logs().querySelectorAll(".pagination-navigation")).toHaveLength(2);
    expect([...logs().querySelectorAll('[role="status"]')].map((status) => status.textContent)).toEqual(["Page 2 of 2 · 22 entries"]);
    expect([...app.container.querySelectorAll(".queue-row__subscription")].map((cell) => cell.textContent)).toEqual(["Dune + 2160p", "Subscription 77"]);
    expect(logs().querySelector(".diagnostic-row .diagnostic-source small")?.textContent).toBe("admin · Dune + 2160p");
  } finally { await app.cleanup(); }

  // 15 Rutor rows fit on one page: the server clamps page 2 to 1 and the address follows without a new entry.
  window.history.pushState({}, "", "/");
  const start = window.history.length;
  app = await renderApp("/admin/diagnostics?tracker=rutor&page=2");
  try {
    expect(currentUrl()).toBe("/admin/diagnostics?tracker=rutor");
    expect(window.history.length).toBe(start);
    expect(logs().querySelectorAll(".diagnostic-row")).toHaveLength(15);
    expect(logs().querySelector(".pagination")).toBeNull();

    await act(async () => choose(select("Filter logs by tracker"), ""));
    expect(currentUrl()).toBe("/admin/diagnostics");
    expect(logs().querySelector('[role="status"]')?.textContent).toBe("Page 1 of 3 · 45 entries");
    await act(async () => pageButton(logs(), "Next page").click());
    expect(currentUrl()).toBe("/admin/diagnostics?page=2");
    expect(logs().querySelector('[role="status"]')?.textContent).toBe("Page 2 of 3 · 45 entries");
    await act(async () => choose(select("Filter logs by outcome"), "error"));
    expect(currentUrl()).toBe("/admin/diagnostics?outcome=error");
    expect(Object.fromEntries(lastQuery("/api/admin/diagnostics/observations"))).toEqual({ page: "1", pageSize: "20", outcome: "error" });
    await act(async () => pageButton(logs(), "Last page", 1).click());
    expect(currentUrl()).toBe("/admin/diagnostics?outcome=error&page=2");
    expect(telegram().querySelector('[role="status"]')?.textContent).toBe("Page 1 of 2 · 25 entries");
    await act(async () => pageButton(telegram(), "Next page").click());
    expect(currentUrl()).toBe("/admin/diagnostics?outcome=error&page=2&deliveriesPage=2");
    expect(telegram().querySelectorAll(".diagnostic-row")).toHaveLength(5);
    expect(window.history.length).toBe(start + 5);

    await popState(() => window.history.back());
    expect(currentUrl()).toBe("/admin/diagnostics?outcome=error&page=2");
    expect(telegram().querySelector('[role="status"]')?.textContent).toBe("Page 1 of 2 · 25 entries");
    await popState(() => window.history.go(-2));
    expect(currentUrl()).toBe("/admin/diagnostics?page=2");
    expect(select("Filter logs by outcome").value).toBe("");
    expect(Object.fromEntries(lastQuery("/api/admin/diagnostics/observations"))).toEqual({ page: "2", pageSize: "20" });
    await popState(() => window.history.forward());
    expect(select("Filter logs by outcome").value).toBe("error");
  } finally { await app.cleanup(); }
});

it("enables a global mirror's Save only for valid changes, offers Discard, and is clean again after saving", async () => {
  mockAdmin();
  const { container, cleanup } = await renderApp("/admin/mirrors");
  const row = () => container.querySelector<HTMLFormElement>('form.mirror-row[aria-label="Rutor"]')!;
  const input = () => row().querySelector<HTMLInputElement>('input[type="url"]')!;
  const save = () => row().querySelector<HTMLButtonElement>('button[type="submit"]')!;
  const discard = () => [...row().querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Discard");
  try {
    expect(save().disabled).toBe(true);
    expect(row().textContent).not.toContain("Unsaved changes");
    expect(discard()).toBeUndefined();
    await act(async () => type(input(), "https://rutor.info"));
    expect(save().disabled).toBe(false);
    expect(row().textContent).toContain("Unsaved changes");
    await act(async () => discard()!.click());
    expect(input().value).toBe("https://rutor.is");
    expect(save().disabled).toBe(true);
    expect(row().textContent).not.toContain("Unsaved changes");
    await act(async () => type(input(), "not a url"));
    expect(save().disabled).toBe(true);
    await act(async () => type(input(), "https://rutor.info/"));
    await act(async () => row().querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    expect(input().form).toBe(row());
    await act(async () => row().requestSubmit());
    expect(vi.mocked(api)).toHaveBeenCalledWith("/api/admin/mirrors/rutor", expect.objectContaining({ method: "PUT", body: JSON.stringify({ baseUrl: "https://rutor.info/", enabled: false }) }));
    expect(input().value).toBe("https://rutor.info");
    expect(save().disabled).toBe(true);
    expect(row().textContent).toContain("Disabled");
    expect(row().textContent).not.toContain("Unsaved changes");
  } finally { await cleanup(); }
});
