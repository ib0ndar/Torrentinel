// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ChangePassword, Login } from "./Authentication";
import { setLanguage } from "../i18n";

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
    await act(async () => root.render(<Login onLogin={vi.fn()} notify={vi.fn()} />));
    const username = container.querySelector<HTMLInputElement>('input[autocomplete="username"]')!, password = container.querySelector<HTMLInputElement>('input[type="password"]')!;
    expect(username.value).toBe(""); expect(password.value).toBe("");
    expect(username.required).toBe(true); expect(password.required).toBe(true);
  } finally { await act(async () => root.unmount()); container.remove(); }
});
