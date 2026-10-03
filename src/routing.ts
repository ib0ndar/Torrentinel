import type { TrackerKey } from "./types";

export type MonitorFilter = "all" | "unread" | "errors";
export type MonitorSort = "changed" | "name" | "attention";
export type ActivityFilter = "unread" | "all";
export const MONITOR_FILTERS: readonly MonitorFilter[] = ["all", "unread", "errors"];
export const MONITOR_SORTS: readonly MonitorSort[] = ["changed", "name", "attention"];
export interface MonitorView { collectionId: string | null; filter: MonitorFilter; search: string; page: number; sort: MonitorSort }
export type MonitorViewChange = (change: Partial<MonitorView>, options?: { replace?: boolean }) => void;
export const DEFAULT_MONITOR_VIEW: MonitorView = { collectionId: null, filter: "all", search: "", page: 1, sort: "changed" };

// "/" and unknown paths are an unresolved Monitor view: the app picks the collection and rewrites the URL.
export type Route =
  | { name: "monitor"; view: MonitorView; explicit: boolean }
  | { name: "activity"; filter: ActivityFilter }
  | { name: "settings" }
  | { name: "admin"; tab: AdminTab; explicit: boolean; diagnostics: DiagnosticsView };
export type Navigate = (path: string, options?: { replace?: boolean }) => void;

export type AdminTab = "overview" | "users" | "mirrors" | "diagnostics";
export const ADMIN_TABS: readonly AdminTab[] = ["overview", "users", "mirrors", "diagnostics"];
const DIAGNOSTICS_TRACKERS: readonly TrackerKey[] = ["kinozal", "rutor", "rutracker"];
/** Tracker log filters and page, and the Telegram deliveries page. */
export interface DiagnosticsView { tracker: TrackerKey | ""; outcome: string; page: number; deliveriesPage: number }
export type DiagnosticsViewChange = (change: Partial<DiagnosticsView>, options?: { replace?: boolean }) => void;
export const DEFAULT_DIAGNOSTICS_VIEW: DiagnosticsView = { tracker: "", outcome: "", page: 1, deliveriesPage: 1 };

function pageParameter(value: string | null): number {
  return value && /^\d{1,7}$/.test(value) && Number(value) >= 1 && Number(value) <= 1_000_000 ? Number(value) : 1;
}
export function parseRoute(pathname: string, search: string): Route {
  const query = new URLSearchParams(search);
  if (pathname === "/settings") return { name: "settings" };
  // "/admin" and unknown sub-paths are unresolved and rewritten to the Overview tab.
  if (pathname === "/admin" || pathname.startsWith("/admin/")) {
    const tab = pathname.slice("/admin/".length).replace(/\/$/, "") as AdminTab;
    if (!ADMIN_TABS.includes(tab)) return { name: "admin", tab: "overview", explicit: false, diagnostics: DEFAULT_DIAGNOSTICS_VIEW };
    if (tab !== "diagnostics") return { name: "admin", tab, explicit: true, diagnostics: DEFAULT_DIAGNOSTICS_VIEW };
    const tracker = query.get("tracker") as TrackerKey, outcome = query.get("outcome") ?? "";
    return { name: "admin", tab, explicit: true, diagnostics: { tracker: DIAGNOSTICS_TRACKERS.includes(tracker) ? tracker : "",
      outcome: /^[a-z0-9][a-z0-9-]{0,39}$/i.test(outcome) ? outcome : "", page: pageParameter(query.get("page")), deliveriesPage: pageParameter(query.get("deliveriesPage")) } };
  }
  if (pathname === "/activity") return { name: "activity", filter: query.get("filter") === "all" ? "all" : "unread" };
  const match = /^\/collections\/([^/]+)\/?$/.exec(pathname);
  let collectionId: string | null = null;
  if (match) { try { collectionId = decodeURIComponent(match[1]); } catch { collectionId = null; } }
  if (!collectionId) return { name: "monitor", view: DEFAULT_MONITOR_VIEW, explicit: false };
  const filter = query.get("filter") as MonitorFilter, sort = query.get("sort") as MonitorSort;
  return { name: "monitor", explicit: true, view: {
    collectionId, filter: MONITOR_FILTERS.includes(filter) ? filter : "all", sort: MONITOR_SORTS.includes(sort) ? sort : "changed",
    search: (query.get("q") ?? "").slice(0, 200), page: pageParameter(query.get("page")),
  } };
}
// Defaults are omitted so the plain collection link stays short.
export function monitorPath(view: MonitorView): string {
  if (!view.collectionId) return "/";
  const query = new URLSearchParams();
  if (view.filter !== "all") query.set("filter", view.filter);
  if (view.search) query.set("q", view.search);
  if (view.page > 1) query.set("page", String(view.page));
  if (view.sort !== "changed") query.set("sort", view.sort);
  const search = query.toString();
  return `/collections/${encodeURIComponent(view.collectionId)}${search ? `?${search}` : ""}`;
}
export function activityPath(filter: ActivityFilter): string { return filter === "all" ? "/activity?filter=all" : "/activity"; }
// Only Diagnostics keeps state in the query; defaults are omitted.
export function adminPath(tab: AdminTab, diagnostics: DiagnosticsView = DEFAULT_DIAGNOSTICS_VIEW): string {
  const query = new URLSearchParams();
  if (tab === "diagnostics") {
    if (diagnostics.tracker) query.set("tracker", diagnostics.tracker);
    if (diagnostics.outcome) query.set("outcome", diagnostics.outcome);
    if (diagnostics.page > 1) query.set("page", String(diagnostics.page));
    if (diagnostics.deliveriesPage > 1) query.set("deliveriesPage", String(diagnostics.deliveriesPage));
  }
  const search = query.toString();
  return `/admin/${tab}${search ? `?${search}` : ""}`;
}

const lastCollectionKey = (userId: string) => `torrentinel-last-collection:${userId}`;
export function storedCollectionId(userId: string): string | null {
  try { return localStorage.getItem(lastCollectionKey(userId)); } catch { return null; }
}
export function storeCollectionId(userId: string, id: string): void {
  try { localStorage.setItem(lastCollectionKey(userId), id); } catch { /* Private browsing can block storage. */ }
}
// Plain left clicks navigate in place; modified and middle clicks keep the browser's link behaviour.
export function isPlainClick(event: { button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}
