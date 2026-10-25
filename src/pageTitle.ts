import { useEffect } from "react";

// The browser tab names the current page and, while signed in, the unread count: "(3) Series 2026 · Torrentinel".
let page = "", unread = 0;
function apply() { document.title = `${unread > 0 ? `(${unread > 99 ? "99+" : unread}) ` : ""}${page ? `${page} · ` : ""}Torrentinel`; }

/** Names the page in the tab title; null leaves the title to the page underneath (a drawer over the Monitor). */
export function usePageTitle(title: string | null) {
  useEffect(() => { if (title === null) return; page = title; apply(); }, [title]);
}
/** Shows the unread count in the tab title until the signed-in shell unmounts. */
export function useUnreadTitle(count: number) {
  useEffect(() => { unread = count; apply(); }, [count]);
  useEffect(() => () => { unread = 0; apply(); }, []);
}
