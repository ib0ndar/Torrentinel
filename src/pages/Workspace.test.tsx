// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { api } from "../api";
import { DialogProvider } from "../components/Dialogs";
import { setLanguage } from "../i18n";
import type { SubscriptionSummary, User } from "../types";
import { Workspace } from "./Workspace";
import { useWorkspaceData } from "../hooks/useWorkspaceData";

vi.mock("../api", async (original) => ({ ...await original<object>(), api: vi.fn() }));
afterEach(() => { vi.resetAllMocks(); setLanguage("en"); });

it("keeps top and bottom navigation synchronized and hides both when pagination is off", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const user: User = { id: "user", username: "test", isAdmin: false, mustChangePassword: false, trackerMarkerStyle: "icons", language: "en", paginationEnabled: true, pageSize: 20 };
  vi.mocked(api).mockImplementation(async (path) => {
    if (path === "/api/collections") return { collections: [{ id: "inbox", name: "Inbox", subscriptionCount: 25, unreadCount: 0 }] };
    const page = Number(new URL(path, "http://test").searchParams.get("page") || "1");
    const subscriptions: SubscriptionSummary[] = Array.from({ length: page === 1 ? 20 : 5 }, (_, index) => ({
      id: String((page - 1) * 20 + index + 1), label: `Release ${(page - 1) * 20 + index + 1}`, collectionId: "inbox", type: "direct", requiredTerms: [], ignoredTerms: [], trackerKeys: ["rutor"],
      enabled: true, initialized: true, isUnread: false, unreadCount: 0, eventCount: 0, matchCount: 0, createdAt: "2026-09-30T00:00:00Z",
    }));
    return { subscriptions, total: 25, page, pageCount: 2 };
  });
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container), notify = vi.fn(), onUserChange = vi.fn();
  function Harness({ current }: { current: User }) {
    const data = useWorkspaceData(notify, current.paginationEnabled, current.pageSize);
    return <DialogProvider><Workspace user={current} onUserChange={onUserChange} notify={notify} data={data} onNewCollection={() => undefined} /></DialogProvider>;
  }
  const render = (current: User) => <Harness current={current} />;
  const button = (navigation: Element, label: string) => navigation.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
  try {
    await act(async () => root.render(render(user)));
    const top = container.querySelector('nav[aria-label="Pagination"]')!, bottom = container.querySelector('nav[aria-label="Bottom pagination"]')!;
    expect(top.querySelector(".pagination-size-picker > span")?.textContent).toBe("Entries per page");
    expect(top.querySelector(".pagination-size-picker select")).not.toBeNull();
    expect(container.querySelectorAll(".pagination-navigation")).toHaveLength(2);
    expect(top.textContent).toContain("Page 1 of 2 · 25 entries"); expect(bottom.textContent).toContain("Page 1 of 2 · 25 entries");
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(1);
    expect(bottom.querySelector("select")).toBeNull();
    expect(container.querySelector(".subscription-list")?.nextElementSibling).toBe(bottom);
    for (const nav of [top, bottom]) { expect(button(nav, "First page").disabled).toBe(true); expect(button(nav, "Next page").disabled).toBe(false); }
    await act(async () => button(bottom, "Next page").click());
    for (const nav of [top, bottom]) { expect(nav.textContent).toContain("Page 2 of 2 · 25 entries"); expect(button(nav, "Next page").disabled).toBe(true); expect(button(nav, "Previous page").disabled).toBe(false); }
    expect(container.querySelectorAll(".subscription-row")).toHaveLength(5);
    await act(async () => button(top, "First page").click());
    expect(bottom.textContent).toContain("Page 1 of 2 · 25 entries"); expect(container.querySelectorAll(".subscription-row")).toHaveLength(20);
    await act(async () => setLanguage("ru"));
    expect(bottom.getAttribute("aria-label")).toBe("Навигация под списком"); expect(bottom.textContent).toContain("Страница 1 из 2");
    await act(async () => root.render(render({ ...user, paginationEnabled: false })));
    expect(container.querySelectorAll("nav.pagination")).toHaveLength(0);
  } finally { await act(async () => root.unmount()); container.remove(); }
});
