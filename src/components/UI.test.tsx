// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { Drawer } from "./UI";

it("portals drawers outside the animated stage and closes them with Escape", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const stage = document.createElement("div"); stage.className = "app-stage"; document.body.append(stage);
  const root = createRoot(stage), close = vi.fn();
  try {
    await act(async () => root.render(<Drawer title="Test" subtitle="Subtitle" onClose={close}><button>Save</button></Drawer>));
    expect(stage.querySelector(".drawer-layer")).toBeNull(); expect(document.body.querySelector(".drawer-layer")?.parentElement).toBe(document.body);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); expect(close).toHaveBeenCalledOnce();
  } finally { await act(async () => root.unmount()); stage.remove(); }
  expect(document.querySelector(".drawer-layer")).toBeNull();
});
