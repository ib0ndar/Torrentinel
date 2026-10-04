import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";
import { focusableElements } from "../hooks/useFocusTrap";
import { useI18n } from "../i18n";
import type { Notify } from "../types";

export type Toast = { id: number; message: string; tone: "good" | "bad" };
const MAX_TOASTS = 3, SUCCESS_DURATION_MS = 4_000, RESUMED_MINIMUM_MS = 1_000;

// Up to three stacked toasts, newest last. Identical visible messages (e.g. several requests failing
// at once) add nothing. Past the limit the oldest success goes first, then the oldest toast.
export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(0);
  const notify = useCallback<Notify>((message, tone = "good") => {
    const id = ++nextId.current;
    setToasts((current) => {
      if (current.some((toast) => toast.message === message && toast.tone === tone)) return current;
      const next = [...current, { id, message, tone }];
      if (next.length <= MAX_TOASTS) return next;
      const success = next.findIndex((toast) => toast.tone === "good");
      const evicted = success >= 0 && success < next.length - 1 ? success : 0;
      return next.filter((_, index) => index !== evicted);
    });
  }, []);
  const dismiss = useCallback((id: number) => setToasts((current) => current.filter((toast) => toast.id !== id)), []);
  const clear = useCallback(() => setToasts([]), []);
  return { toasts, notify, dismiss, clear };
}

// Two persistent live regions (polite for success, assertive for errors) share one visual stack:
// both span the same subgrid rows and each toast sits in its row, so the order stays newest last.
export function ToastRegion({ toasts, onDismiss, aboveNavigation = false }: { toasts: Toast[]; onDismiss: (id: number) => void; aboveNavigation?: boolean }) {
  const firstRow = MAX_TOASTS - toasts.length + 1;
  const items = (tone: Toast["tone"]) => toasts.map((toast, index) => toast.tone === tone && <ToastItem key={toast.id} toast={toast} row={firstRow + index} onDismiss={onDismiss} />);
  // data-modal-companion: an open drawer or dialog includes these buttons in its Tab loop, so an error can be
  // reached and dismissed without closing the panel.
  return <div className={`toast-stack ${aboveNavigation ? "toast-stack--navigation" : ""}`} data-modal-companion>
    <div className="toast-region" role="status" aria-live="polite" aria-atomic="false">{items("good")}</div>
    <div className="toast-region" role="alert" aria-live="assertive" aria-atomic="false">{items("bad")}</div>
  </div>;
}

// Success toasts close after four seconds (paused while hovered or focused); errors stay until dismissed.
function ToastItem({ toast, row, onDismiss }: { toast: Toast; row: number; onDismiss: (id: number) => void }) {
  const { t } = useI18n();
  const [hovered, setHovered] = useState(false), [focused, setFocused] = useState(false);
  const remaining = useRef(SUCCESS_DURATION_MS), element = useRef<HTMLDivElement>(null);
  const paused = hovered || focused;
  useEffect(() => {
    if (toast.tone !== "good" || paused) return;
    const started = Date.now(), timer = window.setTimeout(() => onDismiss(toast.id), remaining.current);
    return () => { window.clearTimeout(timer); remaining.current = Math.max(RESUMED_MINIMUM_MS, remaining.current - (Date.now() - started)); };
  }, [toast, paused, onDismiss]);
  // Closing a focused toast moves focus to another toast or back into the open panel instead of the page body.
  function close() {
    const own = element.current;
    if (own?.contains(document.activeElement)) {
      const stack = own.closest<HTMLElement>("[data-modal-companion]"), modals = document.querySelectorAll<HTMLElement>('[aria-modal="true"]');
      const others = stack ? focusableElements(stack).filter((button) => !own.contains(button)) : [];
      const modal = modals[modals.length - 1];
      const target = others[0] ?? (modal ? focusableElements(modal)[0] : undefined);
      onDismiss(toast.id);
      if (target) window.requestAnimationFrame(() => { if (target.isConnected) target.focus({ preventScroll: true }); });
      return;
    }
    onDismiss(toast.id);
  }
  return <div ref={element} className={`toast toast--${toast.tone}`} style={{ gridRow: row }} onPointerEnter={() => setHovered(true)} onPointerLeave={() => setHovered(false)}
    onFocus={() => setFocused(true)} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false); }}
    onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); } }}>
    <Icon name={toast.tone === "bad" ? "alert" : "check"} size={17} />
    <span className="toast__message">{toast.message}</span>
    <button type="button" className="toast__close" aria-label={t("Dismiss notification")} title={t("Dismiss notification")} onClick={close}><Icon name="close" size={15} /></button>
  </div>;
}
