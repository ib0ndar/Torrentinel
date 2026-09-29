// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DialogProvider, useDialog } from "./Dialogs";

let root: Root;
let container: HTMLDivElement;
let dialog: ReturnType<typeof useDialog>;
const options = { eyebrow: "Test", title: "Confirm", description: "Test request", confirmLabel: "Accept" };
function Harness() { dialog = useDialog(); return <button>Original focus</button>; }
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<DialogProvider><Harness /></DialogProvider>));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
});
describe("dialog lifecycle", () => {
  it("queues concurrent prompts and resets each prompt's initial value", async () => {
    let first!: Promise<string | null>;
    let second!: Promise<string | null>;
    await act(async () => {
      first = dialog.prompt({ ...options, title: "First", inputLabel: "Name", initialValue: "one" });
      second = dialog.prompt({ ...options, title: "Second", inputLabel: "Name", initialValue: "two" });
    });
    expect(container.querySelector("h2")?.textContent).toBe("First");
    await act(async () => { container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    expect(await first).toBe("one");
    expect(container.querySelector("h2")?.textContent).toBe("Second");
    expect(container.querySelector("input")?.value).toBe("two");
    await act(async () => { container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    expect(await second).toBe("two");
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });
  it("cancels with Escape and restores focus and body scrolling", async () => {
    const original = container.querySelector("button")!;
    original.focus();
    document.body.style.overflow = "auto";
    let result!: Promise<boolean>;
    await act(async () => { result = dialog.confirm(options); });
    expect(document.body.style.overflow).toBe("hidden");
    await act(async () => vi.advanceTimersByTime(20));
    expect(document.activeElement?.textContent).toBe("Accept");
    await act(async () => container.querySelector('[role="dialog"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(await result).toBe(false);
    expect(document.body.style.overflow).toBe("auto");
    expect(document.activeElement).toBe(original);
    document.body.style.overflow = "";
  });
  it("settles active and queued requests when the provider unmounts", async () => {
    let confirm!: Promise<boolean>;
    let prompt!: Promise<string | null>;
    await act(async () => {
      confirm = dialog.confirm(options);
      prompt = dialog.prompt({ ...options, inputLabel: "Name" });
    });
    await act(async () => root.unmount());
    expect(await confirm).toBe(false);
    expect(await prompt).toBeNull();
    expect(document.body.style.overflow).toBe("");
    expect(vi.getTimerCount()).toBe(0);
  });
  it("does not let Escape close a drawer behind the dialog", async () => {
    const drawerEscape = vi.fn();
    window.addEventListener("keydown", drawerEscape);
    try {
      let result!: Promise<boolean>;
      await act(async () => { result = dialog.confirm(options); });
      await act(async () => container.querySelector('[role="dialog"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
      expect(await result).toBe(false);
      expect(drawerEscape).not.toHaveBeenCalled();
    } finally { window.removeEventListener("keydown", drawerEscape); }
  });
});
