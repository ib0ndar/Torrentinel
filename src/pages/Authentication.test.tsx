// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ChangePassword, Login } from "./Authentication";

it("explains the password change for the first-run administrator and for members with a temporary password", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container), onSignOut = vi.fn();
  const base = { id: "u", mustChangePassword: true, language: "en" as const, trackerMarkerStyle: "icons" as const, paginationEnabled: false, pageSize: 20, theme: "sentinel" as const };
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
