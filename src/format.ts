import { getLanguage, translate as t } from "./i18n";
import type { TrackerKey } from "./types";

export const POLL_INTERVAL_OPTIONS = [5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 240, 300, 360] as const;
export const POLL_INTERVAL_MARKERS = [5, 60, 180, 360] as const;
export function capitalize(value: string): string { return value[0].toUpperCase() + value.slice(1); }
export function trackerName(key: TrackerKey): string { return key === "rutracker" ? "RuTracker" : key === "kinozal" ? "Kinozal" : "Rutor"; }
export function errorMessage(error: unknown): string { return t(error instanceof Error ? error.message : String(error)); }
export function isHttpUrl(value: string): boolean {
  try { return ["http:", "https:"].includes(new URL(value).protocol); } catch { return false; }
}
export function relativeTime(value: string): string {
  const seconds = Math.round((new Date(value).getTime() - Date.now()) / 1_000), abs = Math.abs(seconds);
  const formatter = new Intl.RelativeTimeFormat(getLanguage(), { numeric: "auto" });
  if (abs < 60) return formatter.format(seconds, "second");
  if (abs < 3_600) return formatter.format(Math.round(seconds / 60), "minute");
  if (abs < 86_400) return formatter.format(Math.round(seconds / 3_600), "hour");
  if (abs < 2_592_000) return formatter.format(Math.round(seconds / 86_400), "day");
  return new Date(value).toLocaleDateString(getLanguage(), { month: "short", day: "numeric", year: new Date(value).getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
}
export function absoluteTime(value: string): string { return new Date(value).toLocaleString(getLanguage(), { dateStyle: "medium", timeStyle: "short" }); }
export function nearestPollIntervalIndex(minutes: number): number {
  return POLL_INTERVAL_OPTIONS.reduce((bestIndex, option, index) => Math.abs(option - minutes) < Math.abs(POLL_INTERVAL_OPTIONS[bestIndex] - minutes) ? index : bestIndex, 0);
}
export function formatPollInterval(minutes: number): string {
  if (minutes < 60) return t("{minutes} minutes", { minutes });
  const hours = Math.floor(minutes / 60), remainder = minutes % 60;
  return remainder ? t("{hours}h {minutes}m", { hours, minutes: remainder }) : t(hours === 1 ? "{hours} hour" : "{hours} hours", { hours });
}
export function shortPollInterval(minutes: number): string { return minutes < 60 ? t("{minutes}m", { minutes }) : t("{hours}h", { hours: minutes / 60 }); }
export function pollingCadence(minutes: number): string { return minutes === 60 ? t("Polling every hour") : t("Polling every {interval}", { interval: formatPollInterval(minutes) }); }
export function formatCoverageMinutes(minutes: number): string {
  if (minutes < 60) return t("{minutes}m", { minutes: Math.round(minutes) });
  const hours = Math.floor(minutes / 60), remainder = Math.round(minutes % 60);
  return remainder ? t("{hours}h {minutes}m", { hours, minutes: remainder }) : t("{hours}h", { hours });
}
export function diagnosticStateClass(outcome: string): string {
  if (["error", "failed", "missing", "blocked", "auth", "parse", "network", "unsupported", "coverage-gap"].includes(outcome)) return "state--error";
  if (["changed", "new-matches"].includes(outcome)) return "state--changed";
  if (["skipped", "temporarily-unavailable", "challenge", "pending", "sending"].includes(outcome)) return "state--pending";
  return "state--good";
}
export function deliveryMethodLabel(method: string): string { return t(method === "photo-url" ? "Photo by URL" : method === "photo-upload" ? "Uploaded photo" : method === "photo-cache" ? "Cached photo" : method === "none" ? "Not attempted" : "Text"); }
export function formatDiagnosticDuration(durationMs: number): string { return durationMs < 1_000 ? `${durationMs} ms` : `${(durationMs / 1_000).toFixed(durationMs < 10_000 ? 1 : 0)} s`; }
