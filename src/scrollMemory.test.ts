// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { entryKey, newEntryState, rememberScroll, replacedEntryState, restoreScroll, savedScroll } from "./scrollMemory";

let y = 0, maxY = 0, frames: FrameRequestCallback[] = [];
const runFrame = () => { const pending = frames; frames = []; pending.forEach((callback) => callback(performance.now())); };
beforeEach(() => {
  y = 0; maxY = 0; frames = [];
  Object.defineProperty(window, "scrollY", { configurable: true, get: () => y });
  vi.spyOn(window, "scrollTo").mockImplementation(((x: number, top: number) => { y = Math.min(top, maxY); }) as typeof window.scrollTo);
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => { frames.push(callback); return frames.length; });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => { frames = []; });
  window.history.replaceState({}, "", "/");
});
afterEach(() => { vi.restoreAllMocks(); Reflect.deleteProperty(window, "scrollY"); });

it("keeps one key per history entry and remembers its position", () => {
  const key = entryKey();
  expect(entryKey()).toBe(key);
  y = 420; rememberScroll();
  expect(savedScroll()).toBe(420);
  window.history.replaceState(replacedEntryState(), "", "/settings");
  expect(entryKey()).toBe(key);
  window.history.pushState(newEntryState(), "", "/activity");
  expect(entryKey()).not.toBe(key);
  expect(savedScroll()).toBeUndefined();
});

it("retries while the page is still too short, then stops at the target", () => {
  restoreScroll(800);
  expect(y).toBe(0);
  maxY = 500; runFrame();
  expect(y).toBe(500);
  maxY = 2000; runFrame();
  expect(y).toBe(800);
  expect(frames).toHaveLength(0);
});

it("stops as soon as the user scrolls, clicks or presses a key", () => {
  restoreScroll(800);
  window.dispatchEvent(new Event("wheel"));
  maxY = 2000; runFrame();
  expect(y).toBe(0);
  expect(window.scrollTo).toHaveBeenCalledTimes(1);
});

it("gives up after the timeout when the content never gets tall enough", () => {
  const now = vi.spyOn(performance, "now").mockReturnValue(0);
  restoreScroll(800, 1000);
  maxY = 300;
  now.mockReturnValue(1500); runFrame();
  expect(y).toBe(300);
  expect(frames).toHaveLength(0);
});
