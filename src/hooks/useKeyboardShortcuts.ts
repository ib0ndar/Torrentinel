import { useEffect, useLayoutEffect, useRef } from "react";

export type ShortcutKey = "/" | "?" | "a" | "j" | "k";
type Shortcuts = Partial<Record<ShortcutKey, () => void>>;
// Shortcuts pause while a dialog, drawer or menu is open.
const BLOCKING_LAYERS = ".dialog-layer, .drawer-layer, .menu-popover, [aria-modal='true']";

function shortcutKey(event: KeyboardEvent): ShortcutKey | null {
  const { key, code, shiftKey } = event;
  if (key === "/" || key === "?") return key;
  // Non-Latin layouts (e.g. Russian) still report the physical key: "." / "," on the slash key, letters in code.
  if (code === "Slash" && (key === "." || key === ",")) return shiftKey ? "?" : "/";
  if (shiftKey) return null;
  if (key === "a" || key === "j" || key === "k") return key;
  if (/^\p{L}$/u.test(key)) { const letter = /^Key([AJK])$/.exec(code)?.[1].toLowerCase(); return letter ? letter as ShortcutKey : null; }
  return null;
}
function isEditable(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])"));
}

// Single-key page shortcuts. Ignored while typing, with Ctrl/Meta/Alt, and while a modal layer or menu is open.
export function useKeyboardShortcuts(shortcuts: Shortcuts): void {
  const latest = useRef(shortcuts);
  useLayoutEffect(() => { latest.current = shortcuts; });
  useEffect(() => {
    const keyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
      if (isEditable(event.target) || document.querySelector(BLOCKING_LAYERS)) return;
      const key = shortcutKey(event), action = key ? latest.current[key] : undefined;
      if (!action) return;
      event.preventDefault();
      action();
    };
    document.addEventListener("keydown", keyDown);
    return () => document.removeEventListener("keydown", keyDown);
  }, []);
}

// j/k: the next or previous row; without a focused row j starts at the first and k at the last.
export function moveRowFocus(selector: string, step: 1 | -1): void {
  const rows = [...document.querySelectorAll<HTMLElement>(selector)];
  if (!rows.length) return;
  const index = rows.indexOf(document.activeElement as HTMLElement);
  rows[index < 0 ? (step > 0 ? 0 : rows.length - 1) : Math.min(rows.length - 1, Math.max(0, index + step))].focus();
}
