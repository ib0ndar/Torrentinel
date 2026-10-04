// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DialogProvider, useDialog } from "./Dialogs";
import { Drawer } from "./UI";
import { ToastRegion, useToasts } from "./Toasts";

const originalRects = HTMLElement.prototype.getClientRects;
// jsdom has no layout; treat every rendered element as visible for the focus trap.
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); HTMLElement.prototype.getClientRects = function () { return [{}] as unknown as DOMRectList; }; });
afterEach(() => { HTMLElement.prototype.getClientRects = originalRects; document.body.innerHTML = ""; document.body.style.overflow = ""; });
const nextFrame = () => act(() => new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve())));
const tab = (shiftKey = false) => act(async () => { (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey, bubbles: true, cancelable: true })); });

it("portals drawers outside the animated stage and closes them with Escape", async () => {
  const stage = document.createElement("div"); stage.className = "app-stage"; document.body.append(stage);
  const root = createRoot(stage), close = vi.fn();
  try {
    await act(async () => root.render(<Drawer title="Test" subtitle="Subtitle" onClose={close}><button>Save</button></Drawer>));
    expect(stage.querySelector(".drawer-layer")).toBeNull(); expect(document.body.querySelector(".drawer-layer")?.parentElement).toBe(document.body);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); expect(close).toHaveBeenCalledOnce();
  } finally { await act(async () => root.unmount()); stage.remove(); }
  expect(document.querySelector(".drawer-layer")).toBeNull();
});

function Opener({ autoFocusField = false }: { autoFocusField?: boolean }) {
  const [open, setOpen] = useState(false);
  return <><button className="opener" onClick={() => setOpen(true)}>Open</button>{open && <Drawer title="Details" subtitle="Test" onClose={() => setOpen(false)}>
    <input aria-label="Name" autoFocus={autoFocusField} /><button className="last">Save</button>
  </Drawer>}</>;
}

it("moves focus into the drawer, keeps Tab inside, locks scrolling and returns focus to the opener", async () => {
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Opener />));
    const opener = container.querySelector<HTMLButtonElement>(".opener")!;
    opener.focus();
    document.body.style.overflow = "auto";
    await act(async () => opener.click());
    expect(document.body.style.overflow).toBe("hidden");
    await nextFrame();
    const drawer = document.querySelector<HTMLElement>(".drawer")!, close = drawer.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!;
    expect(document.activeElement).toBe(close);
    await tab(true);
    expect(document.activeElement).toBe(drawer.querySelector(".last"));
    await tab();
    expect(document.activeElement).toBe(close);
    // Focus that escaped the drawer (e.g. after a click on the page behind) is brought back in.
    opener.focus();
    await tab();
    expect(document.activeElement).toBe(close);
    await act(async () => close.click());
    expect(document.querySelector(".drawer")).toBeNull();
    expect(document.activeElement).toBe(opener);
    expect(document.body.style.overflow).toBe("auto");
  } finally { await act(async () => root.unmount()); }
});

it("keeps focus on an autoFocus field instead of moving it to the close button, and still returns it to the opener", async () => {
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Opener autoFocusField />));
    const opener = container.querySelector<HTMLButtonElement>(".opener")!;
    opener.focus();
    await act(async () => opener.click());
    await nextFrame();
    expect(document.activeElement).toBe(document.querySelector('input[aria-label="Name"]'));
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(document.activeElement).toBe(opener);
  } finally { await act(async () => root.unmount()); }
});

it("lets a dialog over a drawer own Tab and Escape, then hands both back to the drawer", async () => {
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container), close = vi.fn();
  let dialog!: ReturnType<typeof useDialog>;
  function Harness() { dialog = useDialog(); return <Drawer title="Details" subtitle="Test" onClose={close}><button className="delete">Delete</button></Drawer>; }
  try {
    await act(async () => root.render(<DialogProvider><Harness /></DialogProvider>));
    await nextFrame();
    const remove = document.querySelector<HTMLButtonElement>(".delete")!;
    remove.focus();
    let result!: Promise<boolean>;
    await act(async () => { result = dialog.confirm({ eyebrow: "Delete", title: "Delete?", description: "Gone for good.", confirmLabel: "Delete" }); });
    await nextFrame();
    const appDialog = document.querySelector<HTMLElement>(".app-dialog")!;
    expect(document.activeElement?.textContent).toBe("Delete");
    expect(appDialog.contains(document.activeElement)).toBe(true);
    await tab();
    expect(document.activeElement).toBe(appDialog.querySelector('button[aria-label="Close dialog"]'));
    await tab(true);
    expect(appDialog.contains(document.activeElement)).toBe(true);
    await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(await result).toBe(false);
    expect(close).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(remove);
    expect(document.body.style.overflow).toBe("hidden");
    await tab();
    expect(document.activeElement).toBe(document.querySelector('.drawer button[aria-label="Close"]'));
    await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(close).toHaveBeenCalledOnce();
  } finally { await act(async () => root.unmount()); }
});

function DrawerWithError() {
  const toasts = useToasts();
  return <>
    <button className="opener" onClick={() => toasts.notify("Save failed", "bad")}>Fail</button>
    <Drawer title="Details" subtitle="Test" onClose={() => undefined}><button className="last">Save</button></Drawer>
    <ToastRegion toasts={toasts.toasts} onDismiss={toasts.dismiss} />
  </>;
}
it("lets Tab reach an error notification while a drawer is open, and returns focus to the drawer when it is closed", async () => {
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<DrawerWithError />));
    await nextFrame();
    await act(async () => container.querySelector<HTMLButtonElement>(".opener")!.click());
    const drawer = document.querySelector<HTMLElement>(".drawer")!, dismiss = () => document.querySelector<HTMLButtonElement>(".toast__close")!;
    const [drawerClose] = [...drawer.querySelectorAll<HTMLButtonElement>("button")];
    drawer.querySelector<HTMLButtonElement>(".last")!.focus();
    await tab();
    expect(document.activeElement).toBe(dismiss());
    await tab();
    expect(document.activeElement).toBe(drawerClose);
    await tab(true);
    expect(document.activeElement).toBe(dismiss());
    await act(async () => { dismiss().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
    await nextFrame();
    expect(document.querySelector(".toast")).toBeNull();
    expect(drawer.contains(document.activeElement)).toBe(true);
  } finally { await act(async () => root.unmount()); container.remove(); }
});
