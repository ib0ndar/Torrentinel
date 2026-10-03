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
      const focusable = focusableElements(container), active = document.activeElement;
      if (!focusable.length) { event.preventDefault(); return; }
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (!container.contains(active)) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }
      else if (event.shiftKey && active === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && active === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", keyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", keyDown);
      openModals.splice(openModals.indexOf(modal), 1);
      document.body.style.overflow = previousOverflow;
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [ref, opener]);
}
