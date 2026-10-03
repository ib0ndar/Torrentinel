// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Notify } from "../types";
import { ToastRegion, useToasts } from "./Toasts";

let root: Root, container: HTMLDivElement, notify: Notify, clear: () => void;
function Harness() { const toasts = useToasts(); notify = toasts.notify; clear = toasts.clear; return <ToastRegion toasts={toasts.toasts} onDismiss={toasts.dismiss} aboveNavigation />; }
const shown = () => [...container.querySelectorAll<HTMLElement>(".toast")].sort((a, b) => Number(a.style.gridRowStart || a.style.gridRow) - Number(b.style.gridRowStart || b.style.gridRow)).map((toast) => toast.textContent);
const toast = (text: string) => [...container.querySelectorAll<HTMLElement>(".toast")].find((element) => element.textContent === text)!;
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers();
  container = document.createElement("div"); document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<Harness />));
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); });

it("announces successes politely and errors assertively from persistent live regions above the mobile navigation", async () => {
  const [status, alert] = [...container.querySelectorAll(".toast-region")];
  expect(container.querySelector(".toast-stack")?.classList.contains("toast-stack--navigation")).toBe(true);
  expect([status.getAttribute("role"), status.getAttribute("aria-live"), status.getAttribute("aria-atomic")]).toEqual(["status", "polite", "false"]);
  expect([alert.getAttribute("role"), alert.getAttribute("aria-live"), alert.getAttribute("aria-atomic")]).toEqual(["alert", "assertive", "false"]);
  await act(async () => { notify("Saved"); notify("Server unavailable", "bad"); });
  expect(status.textContent).toBe("Saved");
  expect(alert.textContent).toBe("Server unavailable");
  expect(toast("Server unavailable").classList.contains("toast--bad")).toBe(true);
  for (const element of container.querySelectorAll(".toast")) expect(element.querySelector("button")?.getAttribute("aria-label")).toBe("Dismiss notification");
});

it("stacks up to three toasts newest last, ignores identical ones and drops the oldest success first", async () => {
  await act(async () => { notify("First error", "bad"); notify("Saved"); notify("Saved"); notify("Second error", "bad"); });
  expect(shown()).toEqual(["First error", "Saved", "Second error"]);
  expect([...container.querySelectorAll<HTMLElement>(".toast")].map((element) => element.style.gridRow).sort()).toEqual(["1", "2", "3"]);
  await act(async () => notify("Third error", "bad"));
  expect(shown()).toEqual(["First error", "Second error", "Third error"]);
  await act(async () => notify("Renamed"));
  expect(shown()).toEqual(["Second error", "Third error", "Renamed"]);
  await act(async () => clear());
  expect(shown()).toEqual([]);
  await act(async () => notify("Only one"));
  expect(toast("Only one").style.gridRow).toBe("3");
});

it("closes successes after four seconds unless hovered or focused, and keeps errors until dismissed", async () => {
  await act(async () => { notify("Saved"); notify("Failed", "bad"); });
  await act(async () => vi.advanceTimersByTime(3_900));
  expect(shown()).toEqual(["Saved", "Failed"]);
  await act(async () => toast("Saved").dispatchEvent(new MouseEvent("pointerover", { bubbles: true })));
  await act(async () => vi.advanceTimersByTime(10_000));
  expect(shown()).toEqual(["Saved", "Failed"]);
  await act(async () => toast("Saved").dispatchEvent(new MouseEvent("pointerout", { bubbles: true })));
  await act(async () => vi.advanceTimersByTime(900));
  expect(shown()).toEqual(["Saved", "Failed"]);
  await act(async () => vi.advanceTimersByTime(200));
  expect(shown()).toEqual(["Failed"]);

  await act(async () => notify("Moved"));
  await act(async () => toast("Moved").querySelector("button")!.focus());
  await act(async () => vi.advanceTimersByTime(10_000));
  expect(shown()).toEqual(["Failed", "Moved"]);
  await act(async () => toast("Moved").querySelector("button")!.blur());
  await act(async () => vi.advanceTimersByTime(4_000));
  expect(shown()).toEqual(["Failed"]);

  await act(async () => vi.advanceTimersByTime(60_000));
  expect(shown()).toEqual(["Failed"]);
  const close = toast("Failed").querySelector("button")!;
  close.focus();
  await act(async () => close.click());
  expect(shown()).toEqual([]);
});

it("dismisses a focused toast with Escape without closing anything behind it", async () => {
  const behind = vi.fn();
  window.addEventListener("keydown", behind);
  try {
    await act(async () => notify("Failed", "bad"));
    const close = toast("Failed").querySelector("button")!;
    close.focus();
    await act(async () => close.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(shown()).toEqual([]);
    expect(behind).not.toHaveBeenCalled();
  } finally { window.removeEventListener("keydown", behind); }
});
