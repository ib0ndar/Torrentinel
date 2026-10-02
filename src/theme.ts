import { THEME_PREFERENCES, type ThemePreference } from "./types";

export type ThemeId = Exclude<ThemePreference, "auto">;
export const THEME_STORAGE_KEY = "torrentinel-theme";
// English labels are i18n keys; color is the browser chrome (theme-color) for each palette.
export const THEMES: ReadonlyArray<{ id: ThemeId; label: string; family: string; color: string }> = [
  { id: "sentinel", label: "Sentinel", family: "Dark · default", color: "#0b1020" },
  { id: "graphite", label: "Graphite", family: "Dark", color: "#111113" },
  { id: "frost", label: "Frost", family: "Dark", color: "#2e3440" },
  { id: "nebula", label: "Nebula", family: "Dark", color: "#120e20" },
  { id: "ember", label: "Ember", family: "Dark", color: "#15110e" },
  { id: "daylight", label: "Daylight", family: "Light", color: "#ffffff" },
  { id: "paper", label: "Paper", family: "Light", color: "#eee6d6" },
  { id: "high-contrast", label: "High contrast", family: "Dark", color: "#000000" },
];
export const THEME_CHOICES: ReadonlyArray<{ id: ThemePreference; label: string; family: string }> = [
  { id: "auto", label: "Auto", family: "Matches your device" }, ...THEMES,
];

export function themePreference(value: unknown): ThemePreference {
  return THEME_PREFERENCES.includes(value as ThemePreference) ? value as ThemePreference : "sentinel";
}
export function resolveTheme(preference: ThemePreference, prefersLight: boolean): ThemeId {
  return preference === "auto" ? prefersLight ? "daylight" : "sentinel" : preference;
}
export function storedThemePreference(): ThemePreference {
  try { return themePreference(localStorage.getItem(THEME_STORAGE_KEY)); } catch { return "sentinel"; }
}

let stopFollowingDevice: (() => void) | undefined;
// public/theme-init.js reads the remembered preference before the bundle loads, avoiding a flash of the default theme.
export function applyTheme(value: unknown): void {
  const preference = themePreference(value);
  stopFollowingDevice?.();
  stopFollowingDevice = undefined;
  try { localStorage.setItem(THEME_STORAGE_KEY, preference); } catch { /* Private browsing can block storage. */ }
  const media = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-color-scheme: light)") : undefined;
  const update = () => {
    const theme = resolveTheme(preference, media?.matches ?? false);
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", THEMES.find((item) => item.id === theme)!.color);
  };
  update();
  if (preference === "auto" && media) {
    media.addEventListener("change", update);
    stopFollowingDevice = () => media.removeEventListener("change", update);
  }
}
