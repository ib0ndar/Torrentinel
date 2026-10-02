// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { Login } from "./Authentication";

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
