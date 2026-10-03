// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import App from "../App";
import { api, ApiError } from "../api";
import { DialogProvider } from "../components/Dialogs";
import { setLanguage } from "../i18n";
import { applyTheme } from "../theme";
import { PAGE_SIZE_OPTIONS, THEME_PREFERENCES, type Tracker, type User } from "../types";
import { Settings } from "./Settings";

vi.mock("../api", async (original) => ({ ...await original<object>(), api: vi.fn() }));
afterEach(() => { vi.resetAllMocks(); setLanguage("en"); });
it("shows and saves the default page-size dropdown even with pagination disabled", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const user: User = { id: "user", username: "test", isAdmin: false, mustChangePassword: false, trackerMarkerStyle: "icons", language: "en", paginationEnabled: false, pageSize: 50, theme: "sentinel" };
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
it("previews a chosen theme immediately, saves it per account and reverts if saving fails", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const user: User = { id: "user", username: "test", isAdmin: false, mustChangePassword: false, trackerMarkerStyle: "icons", language: "en", paginationEnabled: true, pageSize: 50, theme: "sentinel" };
  let failSave = false;
  vi.mocked(api).mockImplementation(async (path, init) => {
    if (path === "/api/telegram") return { telegram: { configured: false, linked: false } };
    if (path === "/api/trackers") return { trackers: [] };
    if (failSave) throw new Error("Server unavailable");
    return { user: { ...user, ...JSON.parse(String(init?.body)) } };
  });
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container), onUserChange = vi.fn(), notify = vi.fn();
  const render = (current: User) => act(async () => root.render(<DialogProvider><Settings user={current} onUserChange={onUserChange} notify={notify} /></DialogProvider>));
  const choose = (theme: string) => act(async () => { container.querySelector<HTMLInputElement>(`.theme-options input[value="${theme}"]`)!.click(); });
  try {
    await render(user);
    const options = [...container.querySelectorAll<HTMLInputElement>(".theme-options input[type=radio]")];
    expect(options.map((input) => input.value)).toEqual([...THEME_PREFERENCES]);
    expect(options.filter((input) => input.checked).map((input) => input.value)).toEqual(["sentinel"]);
    expect(container.querySelectorAll(".theme-option__check")).toHaveLength(1);
    expect(container.querySelectorAll(".theme-option")[0].querySelectorAll("[data-theme]")).toHaveLength(2);

    await choose("daylight");
    expect(document.documentElement.dataset.theme).toBe("daylight");
    expect(api).toHaveBeenCalledWith("/api/settings/preferences", expect.objectContaining({ method: "PUT", body: JSON.stringify({ theme: "daylight" }) }));
    expect(onUserChange).toHaveBeenCalledWith(expect.objectContaining({ theme: "daylight", pageSize: 50 }));

    await render({ ...user, theme: "daylight" });
    failSave = true;
    await choose("nebula");
    expect(notify).toHaveBeenLastCalledWith("Server unavailable", "bad");
    expect(document.documentElement.dataset.theme).toBe("daylight");

    await act(async () => setLanguage("ru"));
    expect(container.querySelector(".theme-options")?.textContent).toContain("Дневной свет");
  } finally { await act(async () => root.unmount()); container.remove(); applyTheme("sentinel"); }
});

const member: User = { id: "user", username: "test", isAdmin: false, mustChangePassword: false, trackerMarkerStyle: "icons", language: "en", paginationEnabled: true, pageSize: 20, theme: "sentinel" };
const type = (input: HTMLInputElement, value: string) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); };
function tracker(key: "kinozal" | "rutracker", options: Partial<Tracker> = {}): Tracker {
  const globalBaseUrl = key === "kinozal" ? "https://kinozal.tv" : "https://rutracker.org";
  return { key, displayName: key === "kinozal" ? "Kinozal" : "RuTracker", hosts: [], snapshotVersion: 1, capabilities: { authentication: key === "kinozal" ? "required" : "optional", customMirrors: true, direct: true, rules: true, covers: true, ruleDiscovery: key === "kinozal" ? "search" : "feed" },
    baseUrl: globalBaseUrl, globalBaseUrl, hasOverride: false, enabled: true, credentialsConfigured: false, ...options };
}
async function renderSettings(trackers: () => Tracker[] = () => [], extra: (path: string, init?: RequestInit) => unknown = () => undefined) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.mocked(api).mockImplementation(async (path, init) => {
    const handled = await extra(path, init);
    if (handled !== undefined) return handled;
    if (path === "/api/telegram") return { telegram: { configured: false, linked: false } };
    if (path === "/api/trackers") return { trackers: trackers() };
    throw new Error(`Unexpected request: ${path}`);
  });
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container), notify = vi.fn();
  await act(async () => root.render(<DialogProvider><Settings user={member} onUserChange={vi.fn()} notify={notify} /></DialogProvider>));
  return { container, notify, cleanup: async () => { await act(async () => root.unmount()); container.remove(); } };
}

it("links every section from the shortcuts and states how each section saves", async () => {
  const { container, cleanup } = await renderSettings();
  try {
    const links = [...container.querySelectorAll<HTMLAnchorElement>('nav[aria-label="Settings sections"] a')];
    expect(links.map((link) => [link.textContent, link.getAttribute("href")])).toEqual([["Account", "#account"], ["Language", "#language"], ["Appearance", "#appearance"], ["Pagination", "#pagination"],
      ["Source markers", "#source-markers"], ["Telegram bot", "#telegram-bot"], ["Tracker access", "#tracker-access"]]);
    const sections = [...container.querySelectorAll<HTMLElement>("section.settings-section")];
    expect(sections.map((section) => [section.id, section.querySelector("h2")?.textContent, section.querySelector(".save-note")?.textContent])).toEqual([
      ["account", "Account", "Save to apply"], ["language", "Language", "Saved automatically"], ["appearance", "Appearance", "Saved automatically"], ["pagination", "Pagination", "Saved automatically"],
      ["source-markers", "Source markers", "Saved automatically"], ["telegram-bot", "Telegram bot", "Save to apply"], ["tracker-access", "Tracker access", "Save to apply"]]);
    for (const link of links) expect(container.querySelector(link.getAttribute("href")!)?.getAttribute("aria-labelledby")).toBe(`${link.getAttribute("href")!.slice(1)}-heading`);
    await act(async () => setLanguage("ru"));
    expect(links[0].textContent).toBe("Учётная запись");
    expect(sections[1].querySelector(".save-note")?.textContent).toBe("Сохраняется автоматически");
  } finally { await cleanup(); }
});

it("changes the password from the Account section with validation, a success message and cleared fields", async () => {
  const requests: Array<Record<string, string>> = [];
  const { container, notify, cleanup } = await renderSettings(() => [], (path, init) => {
    if (path !== "/api/auth/change-password") return undefined;
    const body = JSON.parse(String(init?.body)) as Record<string, string>; requests.push(body);
    if (body.currentPassword !== "old-password-1") throw new ApiError("Current password is incorrect", 400);
    return { user: member };
  });
  const form = () => container.querySelector<HTMLFormElement>("#account form")!;
  const [current, next, confirm] = [...container.querySelectorAll<HTMLInputElement>('#account input[type="password"]')];
  const submit = () => form().querySelector<HTMLButtonElement>('button[type="submit"]')!;
  const error = () => form().querySelector('[role="alert"]')?.textContent;
  try {
    expect([...form().querySelectorAll("input")].map((input) => [input.type, input.autocomplete])).toEqual([["text", "username"], ["password", "current-password"], ["password", "new-password"], ["password", "new-password"]]);
    expect(form().querySelector<HTMLInputElement>('input[autocomplete="username"]')!.hidden).toBe(true);
    expect([current, next, confirm].every((input) => input.form === form())).toBe(true);
    expect(submit().textContent).toBe("Change password");
    expect(submit().disabled).toBe(true);

    await act(async () => { type(current, "old-password-1"); type(next, "short"); type(confirm, "short"); });
    expect(submit().disabled).toBe(false);
    await act(async () => form().requestSubmit());
    expect(error()).toBe("The new password must have at least 8 characters");
    expect(next.getAttribute("aria-invalid")).toBe("true");
    await act(async () => { type(next, "new-password-1"); type(confirm, "new-password-2"); });
    expect(error()).toBeUndefined();
    await act(async () => form().requestSubmit());
    expect(error()).toBe("New passwords do not match");
    expect(requests).toEqual([]);

    await act(async () => { type(confirm, "new-password-1"); type(current, "wrong-password"); });
    await act(async () => form().requestSubmit());
    expect(error()).toBe("Current password is incorrect");
    expect(notify).not.toHaveBeenCalled();
    expect(next.value).toBe("new-password-1");

    await act(async () => type(current, "old-password-1"));
    await act(async () => form().requestSubmit());
    expect(requests.at(-1)).toEqual({ currentPassword: "old-password-1", newPassword: "new-password-1" });
    expect(notify).toHaveBeenCalledWith("Password changed");
    expect([current.value, next.value, confirm.value]).toEqual(["", "", ""]);
    expect(error()).toBeUndefined();
    expect(container.innerHTML).not.toContain("password-1");
    expect(JSON.stringify(notify.mock.calls)).not.toContain("password-1");
  } finally { await cleanup(); }
});

it("enables tracker Save only for valid unsaved changes, discards them, and submits the row as a form", async () => {
  let kinozalSaved = false;
  const { container, notify, cleanup } = await renderSettings(() => [tracker("kinozal", kinozalSaved ? { credentialsConfigured: true, username: "watcher" } : {}),
    tracker("rutracker", { credentialsConfigured: true, username: "keeper", hasOverride: true, baseUrl: "https://rutracker.net" })], (path, init) => {
    if (path === "/api/trackers/kinozal/settings" && init?.method === "PUT") { kinozalSaved = true; return { ok: true }; }
    return undefined;
  });
  const row = (name: string) => container.querySelector<HTMLFormElement>(`form.tracker-settings-row[aria-label="${name}"]`)!;
  const field = (name: string, label: string) => [...row(name).querySelectorAll("label")].find((element) => element.textContent?.startsWith(label))!.querySelector("input")!;
  const save = (name: string) => row(name).querySelector<HTMLButtonElement>('button[type="submit"]')!;
  const discard = (name: string) => [...row(name).querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Discard");
  try {
    for (const name of ["Kinozal", "RuTracker"]) {
      expect(save(name).disabled).toBe(true);
      expect(row(name).textContent).not.toContain("Unsaved changes");
      expect([field(name, "Mirror override"), field(name, "Username"), field(name, "Password")].every((input) => input.form === row(name))).toBe(true);
      expect(row(name).querySelectorAll('button[type="submit"]')).toHaveLength(1);
    }
    // Status follows the capabilities: Kinozal needs a login; RuTracker polls a feed and uses the login for gap recovery.
    expect([row("Kinozal"), row("RuTracker")].map((form) => [form.querySelector(".integration-heading small")?.textContent, form.querySelector(".state")?.className, form.querySelector(".state")?.textContent])).toEqual([
      ["Login required for polling", "state state--pending", "Login missing"], ["Public feed + authenticated gap recovery; login stored for keeper", "state state--good", "Recovery ready"]]);
    // The source marker previews show the trackers from the same list.
    expect([...container.querySelectorAll(".marker-preview")].map((preview) => [...preview.querySelectorAll(".tracker-tag")].map((tag) => tag.classList[2]))).toEqual([["tracker-tag--kinozal", "tracker-tag--rutracker"], ["tracker-tag--kinozal", "tracker-tag--rutracker"]]);
    expect(field("RuTracker", "Mirror override").value).toBe("https://rutracker.net");
    await act(async () => type(field("RuTracker", "Mirror override"), "https://rutracker.nl"));
    expect(save("RuTracker").disabled).toBe(false);
    expect(row("RuTracker").textContent).toContain("Unsaved changes");
    await act(async () => discard("RuTracker")!.click());
    expect(field("RuTracker", "Mirror override").value).toBe("https://rutracker.net");
    expect(save("RuTracker").disabled).toBe(true);
    expect(discard("RuTracker")).toBeUndefined();

    // A username without a password is an unsaved but incomplete login.
    await act(async () => type(field("Kinozal", "Username"), "watcher"));
    expect(row("Kinozal").textContent).toContain("Unsaved changes");
    expect(save("Kinozal").disabled).toBe(true);
    await act(async () => type(field("Kinozal", "Password"), "tracker-secret"));
    expect(save("Kinozal").disabled).toBe(false);
    await act(async () => type(field("Kinozal", "Mirror override"), "not a url"));
    expect(save("Kinozal").disabled).toBe(true);
    await act(async () => type(field("Kinozal", "Mirror override"), ""));
    await act(async () => type(field("RuTracker", "Mirror override"), "https://rutracker.nl"));
    // Enter in a field submits its own row (jsdom has no implicit submission, so submit the form directly).
    await act(async () => row("Kinozal").requestSubmit());
    expect(api).toHaveBeenCalledWith("/api/trackers/kinozal/settings", expect.objectContaining({ method: "PUT", body: JSON.stringify({ baseUrl: null, username: "watcher", password: "tracker-secret" }) }));
    expect(notify).toHaveBeenCalledWith("Kinozal settings saved");
    expect(field("Kinozal", "Password").value).toBe("");
    expect(save("Kinozal").disabled).toBe(true);
    expect(row("Kinozal").textContent).not.toContain("Unsaved changes");
    expect(row("Kinozal").textContent).toContain("Login stored for watcher");
    // Unsaved edits in another row survive the reload.
    expect(field("RuTracker", "Mirror override").value).toBe("https://rutracker.nl");
    expect(row("RuTracker").textContent).toContain("Unsaved changes");

    const token = container.querySelector<HTMLInputElement>('#telegram-bot input[type="password"]')!;
    expect(token.form).not.toBeNull();
    expect(token.form!.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
    await act(async () => type(token, "123456:example-token-for-tests"));
    expect(token.form!.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(false);
  } finally { await cleanup(); }
});

it("opens the Account section from the account menu and focuses the current password", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.mocked(api).mockImplementation(async (path) => {
    if (path === "/api/auth/me") return { user: { ...member, isAdmin: true } };
    if (path === "/api/system/status") return { scheduler: { running: false }, intervalMinutes: 30 };
    if (path === "/api/collections") return { collections: [{ id: "films", name: "Films", subscriptionCount: 0, unreadCount: 0, activityCount: 0 }] };
    if (path.startsWith("/api/subscriptions?")) return { subscriptions: [], total: 0, page: 1, pageCount: 1 };
    if (path === "/api/telegram") return { telegram: { configured: false, linked: false } };
    if (path === "/api/trackers") return { trackers: [] };
    throw new Error(`Unexpected request: ${path}`);
  });
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  const choose = async (trigger: HTMLButtonElement) => {
    await act(async () => trigger.click());
    await act(async () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent === "Change password")!.click());
  };
  const current = () => container.querySelector<HTMLInputElement>('#account input[autocomplete="current-password"]');
  try {
    await act(async () => root.render(<App />));
    expect(container.querySelector("h1")?.textContent).toBe("Films");
    await choose(container.querySelector<HTMLButtonElement>(".account-button")!);
    expect(window.location.pathname).toBe("/settings");
    expect(document.activeElement).toBe(current());
    current()!.blur();
    // Already on Settings: the mobile Account menu focuses the field again.
    await choose(container.querySelector<HTMLButtonElement>(".account-nav")!);
    expect(window.location.pathname).toBe("/settings");
    expect(document.activeElement).toBe(current());
    // Returning to Settings later does not steal focus again.
    await act(async () => container.querySelector<HTMLAnchorElement>('.app-nav a[aria-label="Monitor"]')!.click());
    await act(async () => container.querySelector<HTMLAnchorElement>('.app-nav a[aria-label="Settings"]')!.click());
    expect(document.activeElement).not.toBe(current());
  } finally { await act(async () => root.unmount()); container.remove(); window.history.replaceState({}, "", "/"); }
});

it("checks for a linked Telegram chat only while the tab is visible and checks again on return", async () => {
  vi.useFakeTimers();
  let visibility: DocumentVisibilityState = "visible", linked = false;
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  const setVisibility = (state: DocumentVisibilityState) => act(async () => { visibility = state; document.dispatchEvent(new Event("visibilitychange")); });
  const { container, cleanup } = await renderSettings(() => [], (path) => path === "/api/telegram" ? { telegram: { configured: true, linked, botUsername: "watch_bot" } } : undefined);
  const checks = () => vi.mocked(api).mock.calls.filter(([path]) => path === "/api/telegram").length;
  try {
    expect(checks()).toBe(1);
    await act(async () => vi.advanceTimersByTime(5_000));
    expect(checks()).toBe(2);
    await setVisibility("hidden");
    await act(async () => vi.advanceTimersByTime(60_000));
    expect(checks()).toBe(2);
    linked = true;
    await setVisibility("visible");
    expect(checks()).toBe(3);
    expect(container.querySelector(".linked-account")).not.toBeNull();
    // Linked: polling stops.
    await act(async () => vi.advanceTimersByTime(60_000));
    expect(checks()).toBe(3);
  } finally { await cleanup(); vi.useRealTimers(); Reflect.deleteProperty(document, "visibilityState"); }
});
