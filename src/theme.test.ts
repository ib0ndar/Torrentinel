// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import themeInitScript from "../public/theme-init.js?raw";
import { applyTheme, resolveTheme, storedThemePreference, THEME_CHOICES, THEME_STORAGE_KEY, themePreference } from "./theme";
import { THEME_PREFERENCES } from "./types";

function mockDeviceScheme(light: boolean) {
  const listeners = new Set<() => void>();
  const media = { matches: light, addEventListener: (_: string, listener: () => void) => listeners.add(listener), removeEventListener: (_: string, listener: () => void) => listeners.delete(listener) };
  vi.stubGlobal("matchMedia", vi.fn(() => media));
  return { listeners, change(value: boolean) { media.matches = value; for (const listener of listeners) listener(); } };
}
function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return { get length() { return values.size; }, clear: () => values.clear(), getItem: (key) => values.get(key) ?? null, key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); }, setItem: (key, value) => { values.set(key, String(value)); } };
}

beforeEach(() => {
  vi.stubGlobal("localStorage", memoryStorage());
  delete document.documentElement.dataset.theme;
  document.head.innerHTML = '<meta name="theme-color" content="#0B1020">';
});
afterEach(() => { applyTheme("sentinel"); vi.unstubAllGlobals(); });

describe("color themes", () => {
  it("offers Auto followed by every palette exactly once", () => {
    expect(THEME_CHOICES.map((choice) => choice.id)).toEqual([...THEME_PREFERENCES]);
  });
  it("resolves Auto from the device scheme and falls back to Sentinel for unknown values", () => {
    expect(resolveTheme("auto", true)).toBe("daylight");
    expect(resolveTheme("auto", false)).toBe("sentinel");
    expect(resolveTheme("paper", false)).toBe("paper");
    expect(themePreference("nebula")).toBe("nebula");
    for (const value of ["retired", "", null, undefined, 3]) expect(themePreference(value)).toBe("sentinel");
  });
  it("applies a fixed theme to the document, browser chrome and remembered preference", () => {
    applyTheme("frost");
    expect(document.documentElement.dataset.theme).toBe("frost");
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute("content")).toBe("#2e3440");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("frost");
    expect(storedThemePreference()).toBe("frost");
  });
  it("follows device changes only while Auto is selected", () => {
    const device = mockDeviceScheme(true);
    applyTheme("auto");
    expect(document.documentElement.dataset.theme).toBe("daylight");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("auto");
    device.change(false);
    expect(document.documentElement.dataset.theme).toBe("sentinel");
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute("content")).toBe("#0b1020");
    applyTheme("ember");
    expect(device.listeners.size).toBe(0);
    device.change(true);
    expect(document.documentElement.dataset.theme).toBe("ember");
  });
  it("falls back to the dark default without matchMedia", () => {
    vi.stubGlobal("matchMedia", undefined);
    applyTheme("auto");
    expect(document.documentElement.dataset.theme).toBe("sentinel");
  });
  it("applies the remembered theme before the bundle loads", () => {
    const run = () => new Function(themeInitScript)();
    run();
    expect(document.documentElement.dataset.theme).toBeUndefined();
    localStorage.setItem(THEME_STORAGE_KEY, "paper"); run();
    expect(document.documentElement.dataset.theme).toBe("paper");
    mockDeviceScheme(true); localStorage.setItem(THEME_STORAGE_KEY, "auto"); run();
    expect(document.documentElement.dataset.theme).toBe("daylight");
    mockDeviceScheme(false); run();
    expect(document.documentElement.dataset.theme).toBe("sentinel");
  });
});
