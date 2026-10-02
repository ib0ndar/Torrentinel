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
  | { name: "admin" };

export function parseRoute(pathname: string, search: string): Route {
  const query = new URLSearchParams(search);
  if (pathname === "/settings") return { name: "settings" };
  if (pathname === "/admin") return { name: "admin" };
  if (pathname === "/activity") return { name: "activity", filter: query.get("filter") === "all" ? "all" : "unread" };
  const match = /^\/collections\/([^/]+)\/?$/.exec(pathname);
  let collectionId: string | null = null;
  if (match) { try { collectionId = decodeURIComponent(match[1]); } catch { collectionId = null; } }
  if (!collectionId) return { name: "monitor", view: DEFAULT_MONITOR_VIEW, explicit: false };
  const filter = query.get("filter") as MonitorFilter, sort = query.get("sort") as MonitorSort, page = query.get("page") ?? "";
  return { name: "monitor", explicit: true, view: {
    collectionId, filter: MONITOR_FILTERS.includes(filter) ? filter : "all", sort: MONITOR_SORTS.includes(sort) ? sort : "changed",
    search: (query.get("q") ?? "").slice(0, 200), page: /^\d{1,7}$/.test(page) && Number(page) >= 1 && Number(page) <= 1_000_000 ? Number(page) : 1,
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
