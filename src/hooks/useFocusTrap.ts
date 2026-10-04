import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";

const FOCUSABLE = "a[href], button:not(:disabled), input:not(:disabled):not([type='hidden']), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])";
// Open modals in mount order; only the topmost one handles Tab (a dialog can open over a drawer).
const openModals: object[] = [];

export function focusableElements(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((element) => element.getClientRects().length > 0);
}

// Modal focus handling shared by dialogs and drawers: moves focus inside after the first frame
// (unless an autoFocus field already has it), keeps Tab and Shift+Tab inside, locks body scrolling
// and restores focus to the opener when the modal closes.
export function useFocusTrap(ref: RefObject<HTMLElement | null>, initialFocus?: (container: HTMLElement) => void): void {
  // Read during the first render: an autoFocus field inside takes focus before any effect runs.
  const [opener] = useState(() => document.activeElement instanceof HTMLElement ? document.activeElement : null);
  // Where the opener sits in a list marked with data-focus-list, in case it disappears while the modal is
  // open (for example, a read entry leaving an Unread list).
  const [origin] = useState(() => {
    const item = opener?.closest<HTMLElement>("[data-focus-item]"), list = item?.closest<HTMLElement>("[data-focus-list]");
    return item && list ? { list, index: listItems(list).indexOf(item) } : null;
  });
  const focusInitial = useRef(initialFocus);
  useLayoutEffect(() => { focusInitial.current = initialFocus; });
  useEffect(() => {
    const modal = {};
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    openModals.push(modal);
    const frame = window.requestAnimationFrame(() => {
      const container = ref.current;
      if (!container || container.contains(document.activeElement)) return;
      if (focusInitial.current) focusInitial.current(container); else focusableElements(container)[0]?.focus();
    });
    const keyDown = (event: KeyboardEvent) => {
      const container = ref.current;
      if (event.key !== "Tab" || openModals.at(-1) !== modal || !container) return;
      // Visible notifications (data-modal-companion) join the loop after the modal's own controls.
      const companions = [...document.querySelectorAll<HTMLElement>("[data-modal-companion]")].flatMap(focusableElements);
      const loop = [...focusableElements(container), ...companions], active = document.activeElement as HTMLElement | null;
      if (!loop.length) { event.preventDefault(); return; }
      const index = active ? loop.indexOf(active) : -1;
      if (index < 0) {
        // Something inside the modal that is not a Tab stop (e.g. a focused heading) keeps native order.
        if (active && container.contains(active)) return;
        event.preventDefault(); (event.shiftKey ? loop[loop.length - 1] : loop[0]).focus();
        return;
      }
      event.preventDefault();
      loop[(index + (event.shiftKey ? -1 : 1) + loop.length) % loop.length].focus();
    };
    document.addEventListener("keydown", keyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", keyDown);
      openModals.splice(openModals.indexOf(modal), 1);
      document.body.style.overflow = previousOverflow;
      if (opener?.isConnected) opener.focus({ preventScroll: true });
      else if (origin) focusNearest(origin);
    };
  }, [ref, opener, origin]);
}
function listItems(list: HTMLElement): HTMLElement[] { return [...list.querySelectorAll<HTMLElement>("[data-focus-item]")]; }
// The item now at the opener's position (or the last one), else the selected filter of the view.
function focusNearest(origin: { list: HTMLElement; index: number }): void {
  const items = origin.list.isConnected ? listItems(origin.list) : [];
  const target = items[Math.min(origin.index, items.length - 1)] ?? document.querySelector<HTMLElement>("[data-focus-fallback] [aria-pressed='true']");
  target?.focus({ preventScroll: true });
}
