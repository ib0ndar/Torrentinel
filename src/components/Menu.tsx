import { type KeyboardEvent as ReactKeyboardEvent, type ReactNode, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon, type IconName } from "./Icon";

export type MenuItem = { id: string; label: string; icon?: IconName; tone?: "danger"; href?: string; title?: string; onSelect?: () => void };
type OpenFocus = "first" | "last";

export function MenuButton({ className, triggerLabel, menuLabel, items, header, align = "end", offset = 6, children }: {
  className: string; triggerLabel?: string; menuLabel: string; items: MenuItem[]; header?: ReactNode; align?: "start" | "end"; offset?: number; children: ReactNode;
}) {
  const [open, setOpen] = useState<OpenFocus | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null), popoverRef = useRef<HTMLDivElement>(null), menuId = useId();
  const close = useCallback((restoreFocus: boolean) => { setOpen(null); if (restoreFocus) triggerRef.current?.focus(); }, []);
  const menuItems = () => [...popoverRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []];
  const place = useCallback(() => {
    const trigger = triggerRef.current, popover = popoverRef.current;
    if (!trigger || !popover) return;
    const rect = trigger.getBoundingClientRect(), margin = 8, gap = offset;
    const width = popover.offsetWidth, height = popover.offsetHeight, viewportWidth = document.documentElement.clientWidth || window.innerWidth, viewportHeight = window.innerHeight;
    const below = rect.bottom + gap, above = rect.top - gap - height;
    const top = below + height <= viewportHeight - margin || above < margin ? below : above;
    const left = align === "start" ? rect.left : rect.right - width;
    popover.style.top = `${Math.round(Math.max(margin, Math.min(top, viewportHeight - height - margin)))}px`;
    popover.style.left = `${Math.round(Math.max(margin, Math.min(left, viewportWidth - width - margin)))}px`;
  }, [align, offset]);
  // Position before paint and move focus into the menu (WAI-ARIA menu button pattern).
  useLayoutEffect(() => {
    if (!open) return;
    place();
    const items = menuItems();
    items[open === "last" ? items.length - 1 : 0]?.focus();
  }, [open, place]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: Event) => { const target = event.target as Node; if (!popoverRef.current?.contains(target) && !triggerRef.current?.contains(target)) close(false); };
    const resize = () => { if (triggerRef.current?.getClientRects().length) place(); else close(false); };
    const navigation = () => close(false);
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("resize", resize);
    window.addEventListener("scroll", place, true);
    window.addEventListener("popstate", navigation);
    return () => { document.removeEventListener("pointerdown", outside, true); window.removeEventListener("resize", resize); window.removeEventListener("scroll", place, true); window.removeEventListener("popstate", navigation); };
  }, [open, close, place]);
  function triggerKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setOpen(event.key === "ArrowDown" ? "first" : "last"); }
  }
  function menuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const items = menuItems(), index = items.indexOf(document.activeElement as HTMLElement);
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); }
    else if (event.key === "Tab") close(true);
    else if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      items[next]?.focus();
    }
  }
  function select(item: MenuItem) { close(true); item.onSelect?.(); }
  return <>
    <button ref={triggerRef} type="button" className={className} aria-label={triggerLabel} title={triggerLabel} aria-haspopup="menu" aria-expanded={open !== null} aria-controls={open ? menuId : undefined}
      onClick={() => open ? close(false) : setOpen("first")} onKeyDown={triggerKeyDown}>{children}</button>
    {open && createPortal(<div ref={popoverRef} className="menu-popover" onKeyDown={menuKeyDown}>
      {header && <div className="menu-popover__header">{header}</div>}
      <div id={menuId} role="menu" aria-label={menuLabel} className="menu-popover__items">{items.map((item) => {
        const content = <>{item.icon && <Icon name={item.icon} size={17} />}<span>{item.label}</span></>, itemClass = `menu-item ${item.tone === "danger" ? "menu-item--danger" : ""}`;
        return item.href
          ? <a key={item.id} role="menuitem" tabIndex={-1} className={itemClass} href={item.href} title={item.title} target="_blank" rel="noreferrer" onClick={() => close(false)}>{content}</a>
          : <button key={item.id} type="button" role="menuitem" tabIndex={-1} className={itemClass} title={item.title} onClick={() => select(item)}>{content}</button>;
      })}</div>
    </div>, document.body)}
  </>;
}
