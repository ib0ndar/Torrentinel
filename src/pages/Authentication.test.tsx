// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ChangePassword, Login } from "./Authentication";
import { api, ApiError } from "../api";
import { LANGUAGE_STORAGE_KEY, setLanguage } from "../i18n";

vi.mock("../api", async (original) => ({ ...await original<object>(), api: vi.fn() }));
afterEach(() => { vi.resetAllMocks(); setLanguage("en"); });
const type = (input: HTMLInputElement, value: string) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); };

it("explains the password change for the first-run administrator and for members with a temporary password", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container), onSignOut = vi.fn();
  const base = { id: "u", mustChangePassword: true, language: "en" as const, trackerMarkerStyle: "icons" as const, paginationEnabled: false, pageSize: 20, theme: "sentinel" as const, startPage: "monitor" as const };
  try {
    await act(async () => root.render(<ChangePassword user={{ ...base, username: "admin", isAdmin: true }} onChanged={vi.fn()} onSignOut={onSignOut} notify={vi.fn()} />));
    expect(container.querySelector("h1")?.textContent).toBe("Secure the admin account.");
    expect(container.querySelector("label")?.textContent).toContain("Current password");
    await act(async () => root.render(<ChangePassword user={{ ...base, username: "bob", isAdmin: false }} onChanged={vi.fn()} onSignOut={onSignOut} notify={vi.fn()} />));
    expect(container.querySelector(".eyebrow")?.textContent).toBe("Password change required");
    expect(container.querySelector("h1")?.textContent).toBe("Choose a new password.");
    expect(container.querySelector("label")?.textContent).toContain("Temporary password");
    await act(async () => container.querySelector<HTMLButtonElement>(".password-sign-out")!.click());
    expect(onSignOut).toHaveBeenCalledOnce();
  } finally { await act(async () => root.unmount()); container.remove(); }
});

it("uses reset and temporary-password wording for administrators who are not on their first-run setup", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  const admin = { id: "a", username: "root", isAdmin: true, mustChangePassword: true, language: "en" as const, trackerMarkerStyle: "icons" as const, paginationEnabled: false, pageSize: 20, theme: "sentinel" as const, startPage: "monitor" as const };
  const view = () => ({ eyebrow: container.querySelector(".eyebrow")?.textContent, title: container.querySelector("h1")?.textContent, text: container.querySelector(".password-panel > p:not(.eyebrow)")?.textContent, label: container.querySelector("label")?.textContent });
  try {
    await act(async () => root.render(<ChangePassword user={{ ...admin, passwordChangeReason: "reset" }} onChanged={vi.fn()} onSignOut={vi.fn()} notify={vi.fn()} />));
    expect(view()).toMatchObject({ eyebrow: "Password reset", title: "Choose a new password.", text: "An administrator reset your password. Enter the temporary password you were given, then choose a new one to continue." });
    expect(view().label).toContain("Temporary password");
    await act(async () => root.render(<ChangePassword user={{ ...admin, passwordChangeReason: "created" }} onChanged={vi.fn()} onSignOut={vi.fn()} notify={vi.fn()} />));
    expect(view()).toMatchObject({ eyebrow: "Password change required", title: "Choose a new password." });
    expect(view().label).toContain("Temporary password");
    await act(async () => root.render(<ChangePassword user={{ ...admin, passwordChangeReason: "initial" }} onChanged={vi.fn()} onSignOut={vi.fn()} notify={vi.fn()} />));
    expect(view()).toMatchObject({ eyebrow: "First sign-in", title: "Secure the admin account." });
    expect(view().label).toContain("Current password");
    await act(async () => setLanguage("ru"));
    await act(async () => root.render(<ChangePassword user={{ ...admin, passwordChangeReason: "reset" }} onChanged={vi.fn()} onSignOut={vi.fn()} notify={vi.fn()} />));
    expect(view()).toMatchObject({ eyebrow: "Сброс пароля", title: "Задайте новый пароль." });
  } finally { await act(async () => setLanguage("en")); await act(async () => root.unmount()); container.remove(); }
});

it("starts the sign-in form with empty, required credentials", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Login onLogin={vi.fn()} />));
    const username = container.querySelector<HTMLInputElement>('input[autocomplete="username"]')!, password = container.querySelector<HTMLInputElement>('input[type="password"]')!;
    expect(username.value).toBe(""); expect(password.value).toBe("");
    expect(username.required).toBe(true); expect(password.required).toBe(true);
  } finally { await act(async () => root.unmount()); container.remove(); }
});

it("shows a failed sign-in in the form: rejected credentials clear and focus the password, other errors keep it", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container), onLogin = vi.fn();
  vi.mocked(api).mockRejectedValueOnce(new ApiError("Invalid username or password", 401)).mockRejectedValueOnce(new ApiError("Too many sign-in attempts. Try again later.", 429));
  const password = () => container.querySelector<HTMLInputElement>('input[autocomplete="current-password"]')!, error = () => container.querySelector('.login-form [role="alert"]');
  const submit = () => act(async () => container.querySelector<HTMLFormElement>(".login-form")!.requestSubmit());
  try {
    await act(async () => root.render(<Login onLogin={onLogin} />));
    expect(error()).toBeNull();
    await act(async () => { type(container.querySelector<HTMLInputElement>('input[autocomplete="username"]')!, "admin"); type(password(), "wrong"); });
    await submit();
    expect(error()?.textContent).toBe("Invalid username or password");
    expect(password().value).toBe(""); expect(document.activeElement).toBe(password());
    expect(password().getAttribute("aria-invalid")).toBe("true"); expect(password().getAttribute("aria-describedby")).toBe(error()!.id);
    expect(error()!.nextElementSibling?.classList.contains("button--primary")).toBe(true);
    await act(async () => type(password(), "again"));
    await submit();
    expect(error()?.textContent).toBe("Too many sign-in attempts. Try again later.");
    expect(password().value).toBe("again"); expect(password().hasAttribute("aria-invalid")).toBe(false);
    expect(onLogin).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); container.remove(); }
});

it("shows and hides the password with a button that is not part of the field's label", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Login onLogin={vi.fn()} />));
    const password = container.querySelector<HTMLInputElement>('input[autocomplete="current-password"]')!, toggle = container.querySelector<HTMLButtonElement>(".password-input__toggle")!;
    expect([password.type, toggle.type, toggle.getAttribute("aria-label")]).toEqual(["password", "button", "Show password"]);
    expect(toggle.closest("label")).toBeNull(); expect([...password.labels!].map((label) => label.textContent)).toEqual(["Password"]);
    await act(async () => toggle.click());
    expect([password.type, toggle.getAttribute("aria-label")]).toEqual(["text", "Hide password"]);
    await act(async () => toggle.click());
    expect(password.type).toBe("password");
  } finally { await act(async () => root.unmount()); container.remove(); }
});

it("switches the interface language outside the form and remembers the choice", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  const choices = () => [...container.querySelectorAll<HTMLButtonElement>(".login-language button")];
  try {
    await act(async () => root.render(<Login onLogin={vi.fn()} />));
    expect(container.querySelector(".login-form select, .login-form .login-language")).toBeNull();
    expect(container.querySelector(".login-language")!.getAttribute("aria-label")).toBe("Language");
    expect(choices().map((choice) => [choice.textContent, choice.lang, choice.getAttribute("aria-pressed")])).toEqual([["English", "en", "true"], ["Русский", "ru", "false"]]);
    await act(async () => choices()[1].click());
    expect(container.querySelector(".login-form h2")?.textContent).toBe("Войти");
    expect(container.querySelector(".login-language")!.getAttribute("aria-label")).toBe("Язык");
    expect(choices().map((choice) => choice.getAttribute("aria-pressed"))).toEqual(["false", "true"]);
    expect(document.documentElement.lang).toBe("ru"); expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe("ru");
  } finally { await act(async () => root.unmount()); container.remove(); }
});
