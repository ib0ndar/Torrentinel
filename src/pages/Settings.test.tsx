// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { api } from "../api";
import { DialogProvider } from "../components/Dialogs";
import { setLanguage } from "../i18n";
import { PAGE_SIZE_OPTIONS, type User } from "../types";
import { Settings } from "./Settings";

vi.mock("../api", async (original) => ({ ...await original<object>(), api: vi.fn() }));
afterEach(() => { vi.resetAllMocks(); setLanguage("en"); });
it("shows and saves the default page-size dropdown even with pagination disabled", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const user: User = { id: "user", username: "test", isAdmin: false, mustChangePassword: false, trackerMarkerStyle: "icons", language: "en", paginationEnabled: false, pageSize: 50 };
  vi.mocked(api).mockImplementation(async (path, init) => path === "/api/telegram" ? { telegram: { configured: false, linked: false } }
    : path === "/api/trackers" ? { trackers: [] } : { user: { ...user, ...JSON.parse(String(init?.body)) } });
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container), onUserChange = vi.fn(), notify = vi.fn();
  try {
    await act(async () => root.render(<DialogProvider><Settings user={user} onUserChange={onUserChange} notify={notify} /></DialogProvider>));
    const label = [...container.querySelectorAll("label")].find((element) => element.textContent?.includes("Default entries per page"))!;
    const select = label.querySelector("select")!;
    expect(label.closest(".settings-control--pagination.settings-control--preferences")).not.toBeNull();
    const preferenceControls = container.querySelectorAll(".settings-control--preferences");
    expect(preferenceControls).toHaveLength(2);
    expect(preferenceControls[0].closest(".settings-section")?.querySelector(".settings-copy p")).toBeNull();
    expect([...preferenceControls].map((control) => control.querySelectorAll("select").length)).toEqual([1, 1]);
    expect(container.querySelector(".telegram-setup")?.closest(".settings-control--preferences")).toBeNull();
    expect([...select.options].map((option) => Number(option.value))).toEqual([...PAGE_SIZE_OPTIONS]);
    expect(select.value).toBe("50"); expect(select.disabled).toBe(false);
    await act(async () => { select.value = "20"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(api).toHaveBeenCalledWith("/api/settings/preferences", expect.objectContaining({ method: "PUT", body: JSON.stringify({ pageSize: 20 }) }));
    expect(onUserChange).toHaveBeenCalledWith(expect.objectContaining({ pageSize: 20, paginationEnabled: false }));
    await act(async () => setLanguage("ru")); expect(container.textContent).toContain("Записей на странице по умолчанию");
    expect(container.textContent).not.toContain("Выберите английский или русский.");
  } finally { await act(async () => root.unmount()); container.remove(); }
});
