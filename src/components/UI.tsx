import { type InputHTMLAttributes, type ReactNode, type Ref, useContext, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon, type IconName } from "./Icon";
import { TrackerMarkerStyleContext } from "./contexts";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { useTrackerName } from "../hooks/useTrackers";
import { useI18n } from "../i18n";
import { isPlainClick } from "../routing";
import type { SubscriptionType, TrackerKey, TrackerMarkerStyle } from "../types";

// A breadcrumb, when given, takes the eyebrow's place above the title.
export function Page({ title, eyebrow, breadcrumb, description, actions, navigation, className, children }: { title: string; eyebrow?: string; breadcrumb?: ReactNode; description?: string; actions?: ReactNode; navigation?: ReactNode; className?: string; children: ReactNode }) {
  return <main className={className ? `page ${className}` : "page"}><header className={navigation ? "page-header page-header--navigation" : "page-header"}><div>{breadcrumb ?? <p className="eyebrow">{eyebrow}</p>}<h1>{title}</h1>{description && <p>{description}</p>}</div>{actions}</header>{navigation}<div className="page-body">{children}</div></main>;
}
// Section tabs that are separate addresses, so they are links (navigation), not an ARIA tablist. When the row is
// wider than the screen it scrolls: the active tab is kept in view and a fade marks each side with more tabs.
export function PageTabs<T extends string>({ label, tabs, active, hrefFor, labelFor, navigate }: { label: string; tabs: readonly T[]; active: T; hrefFor: (tab: T) => string; labelFor: (tab: T) => string; navigate?: (href: string) => void }) {
  const ref = useRef<HTMLElement>(null), [more, setMore] = useState({ left: false, right: false });
  useEffect(() => {
    const nav = ref.current;
    if (!nav) return;
    const update = () => setMore({ left: nav.scrollLeft > 1, right: nav.scrollLeft + nav.clientWidth < nav.scrollWidth - 1 });
    const current = nav.querySelector<HTMLElement>('[aria-current="page"]');
    if (current && nav.scrollWidth > nav.clientWidth) {
      const bounds = nav.getBoundingClientRect(), item = current.getBoundingClientRect(), inset = 40;
      if (item.left < bounds.left + inset) nav.scrollLeft -= bounds.left + inset - item.left;
      else if (item.right > bounds.right - inset) nav.scrollLeft += item.right - (bounds.right - inset);
    }
    update();
    nav.addEventListener("scroll", update, { passive: true }); window.addEventListener("resize", update);
    return () => { nav.removeEventListener("scroll", update); window.removeEventListener("resize", update); };
  }, [active]);
  return <nav ref={ref} className={`page-tabs${more.left ? " page-tabs--more-left" : ""}${more.right ? " page-tabs--more-right" : ""}`} aria-label={label}>{tabs.map((tab) => {
    const href = hrefFor(tab);
    return <a key={tab} href={href} aria-current={tab === active ? "page" : undefined} className={tab === active ? "page-tab page-tab--active" : "page-tab"} onClick={(event) => { if (!navigate || !isPlainClick(event)) return; event.preventDefault(); navigate(href); }}>{labelFor(tab)}</a>;
  })}</nav>;
}
// A drawer has a short label above its title (eyebrow) and/or a sentence below it (description).
export function Drawer({ title, eyebrow, description, onClose, wide = false, extraWide = false, headerMedia, children }: { title: string; eyebrow?: string; description?: string; onClose: () => void; wide?: boolean; extraWide?: boolean; headerMedia?: ReactNode; children: ReactNode }) {
  const { t } = useI18n();
  const drawerRef = useRef<HTMLElement>(null), closeRef = useRef<HTMLButtonElement>(null);
  // An autoFocus field keeps focus; otherwise the close button gets it.
  useFocusTrap(drawerRef, () => closeRef.current?.focus());
  useEffect(() => { const key = (event: KeyboardEvent) => event.key === "Escape" && onClose(); window.addEventListener("keydown", key); return () => window.removeEventListener("keydown", key); }, [onClose]);
  // Render outside the animated application stage: its stacking/transform
  // context must not put fixed drawers behind mobile navigation.
  return createPortal(<div className="drawer-layer" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><aside ref={drawerRef} className={`drawer ${wide ? "drawer--wide" : ""} ${extraWide ? "drawer--details" : ""}`} role="dialog" aria-modal="true" aria-label={title}><header><div className={`drawer-heading ${headerMedia ? "drawer-heading--with-media" : ""}`}>{headerMedia}<div className="drawer-heading__copy">{eyebrow && <p className="eyebrow">{eyebrow}</p>}<h2>{title}</h2>{description && <p className="drawer-description">{description}</p>}</div></div><button ref={closeRef} type="button" className="icon-button" onClick={onClose} aria-label={t("Close")} title={t("Close")}><Icon name="close" /></button></header><div className="drawer-body">{children}</div></aside></div>, document.body);
}
// Toggle buttons in a labelled group (not a tablist: the lists are not tab panels), with optional counts.
export function FilterTabs<T extends string>({ label, options, value, onChange }: { label: string; options: Array<{ value: T; label: string; count?: number; alert?: boolean }>; value: T; onChange: (value: T) => void }) {
  return <div className="filter-tabs" role="group" aria-label={label} data-focus-fallback>{options.map((option) => <button key={option.value} type="button" className={value === option.value ? "active" : ""} aria-pressed={value === option.value} onClick={() => onChange(option.value)}>
    <span className="filter-tabs__label">{option.label}</span>{typeof option.count === "number" && <> <span className={`filter-count ${option.alert && option.count > 0 ? "filter-count--alert" : ""}`}>{option.count}</span></>}
  </button>)}</div>;
}
export function DrawerActions({ onCancel, busy, label, disabled = false }: { onCancel: () => void; busy: boolean; label: string; disabled?: boolean }) {
  const { t } = useI18n();
  return <div className="drawer-actions"><button type="button" className="button button--quiet" onClick={onCancel}>{t("Cancel")}</button><button className="button button--primary" disabled={busy || disabled}>{busy ? t("Saving…") : label}</button></div>;
}
// A password or token input with a show/hide button. The label points at the input (htmlFor) instead of
// wrapping it: inside a <label>, the button's name would become part of the field's name.
type PasswordFieldProps = { label: string; hint?: string; variant?: "field" | "settings" | "dialog"; secret?: "password" | "token"; inputRef?: Ref<HTMLInputElement> }
  & Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "id">;
export function PasswordField({ label, hint, variant = "field", secret = "password", inputRef, ...input }: PasswordFieldProps) {
  const { t } = useI18n(), id = useId(), [shown, setShown] = useState(false);
  const toggle = t(secret === "token" ? shown ? "Hide token" : "Show token" : shown ? "Hide password" : "Show password");
  const control = <div className="password-input"><input {...input} ref={inputRef} id={id} type={shown ? "text" : "password"} />
    <button type="button" className="password-input__toggle" aria-controls={id} aria-label={toggle} title={toggle} onClick={() => setShown((value) => !value)}><Icon name={shown ? "hide" : "show"} /></button></div>;
  if (variant === "settings") return <div className="settings-field"><span><label htmlFor={id}>{label}</label></span>{control}</div>;
  if (variant === "dialog") return <div className="app-dialog__field"><label htmlFor={id}>{label}</label>{control}{hint && <small>{hint}</small>}</div>;
  return <div className="field"><span><label htmlFor={id}><strong>{label}</strong></label>{hint && <small>{hint}</small>}</span>{control}</div>;
}
export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <label className="field"><span><strong>{label}</strong>{hint && <small>{hint}</small>}</span>{children}</label>;
}
export function PhraseInput({ ariaLabel, value, onChange, placeholder }: { ariaLabel: string; value: string[]; onChange: (value: string[]) => void; placeholder?: string }) {
  const { t } = useI18n();
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  function addDraft() {
    const phrase = draft.trim();
    if (!phrase) return;
    if (!value.some((item) => item.toLocaleLowerCase() === phrase.toLocaleLowerCase())) onChange([...value, phrase]);
    setDraft("");
  }
  function removePhrase(index: number) { onChange(value.filter((_, itemIndex) => itemIndex !== index)); }
  return <div className="phrase-input" onClick={() => inputRef.current?.focus()}>
    <input ref={inputRef} className="phrase-input__entry" aria-label={ariaLabel} value={draft} onChange={(event) => setDraft(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); addDraft(); }
        else if (event.key === "Backspace" && !draft && value.length) { event.preventDefault(); removePhrase(value.length - 1); }
      }} placeholder={value.length ? undefined : placeholder} />
    {value.map((phrase, index) => <span className="phrase-chip" key={`${phrase}-${index}`}><span>{phrase}</span><button type="button" aria-label={t("Remove phrase {phrase}", { phrase })} title={t("Remove {phrase}", { phrase })} onMouseDown={(event) => event.preventDefault()} onClick={() => removePhrase(index)}><Icon name="close" size={12} /></button></span>)}
  </div>;
}
export function PhraseDisplay({ phrases }: { phrases: string[] }) {
  return <span className="phrase-display" aria-label={phrases.join(", ")}>{phrases.map((phrase, index) => <span className="phrase-chip phrase-chip--display" key={`${phrase}-${index}`}><span>{phrase}</span></span>)}</span>;
}
export function ReleaseCover({ url, title, thumbnail = false }: { url: string; title: string; thumbnail?: boolean }) {
  const { t } = useI18n();
  const [failed, setFailed] = useState(false);
  const className = `release-cover ${thumbnail ? "release-cover--thumbnail" : ""}`;
  if (failed) return <div className={`${className} release-cover--missing`}><Icon name="alert" size={thumbnail ? 15 : 20} /><span>{t("Cover unavailable")}</span></div>;
  return <div className={className}><img className="release-cover__backdrop" src={url} alt="" aria-hidden="true" referrerPolicy="no-referrer" /><img className="release-cover__artwork" src={url} alt={t("Cover for {title}", { title })} loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(true)} /></div>;
}
export function InfoLine({ icon, children }: { icon: IconName; children: ReactNode }) { return <div className="info-line"><Icon name={icon} /><span>{children}</span></div>; }
export function EmptyState({ icon, title, text, action }: { icon: IconName; title: string; text: string; action?: ReactNode }) { return <div className="empty-state"><span><Icon name={icon} size={32} /></span><h2>{title}</h2><p>{text}</p>{action}</div>; }
export function EmptyCompact({ text }: { text: string }) { return <div className="empty-compact">{text}</div>; }
export function ListSkeleton() { return <div className="skeleton"><span /><span /><span /></div>; }
// Unread keeps the link/rule icon and adds an accent dot on its corner.
export function SubscriptionTypeIcon({ type, unread }: { type: SubscriptionType; unread: boolean }) {
  const { t } = useI18n();
  return <span className={`type-icon type-icon--${type} ${unread ? "type-icon--unread" : ""}`} role="img" aria-label={`${t(unread ? "Unread" : "Read")} ${t(type)} ${t("Subscription")}`} title={t(unread ? "Unread — open to mark read" : "Read")}>
    <Icon name={type === "direct" ? "link" : "rule"} size={17} />{unread && <span className="unread-dot" />}
  </span>;
}
// Presentation only (favicon, letters; colours in styles.css by key). Names come from GET /api/trackers.
const TRACKER_MARKERS: Partial<Record<string, { abbreviation: string; favicon: string }>> = {
  kinozal: { abbreviation: "KZ", favicon: "/tracker-favicons/kinozal.ico" },
  rutor: { abbreviation: "RU", favicon: "/tracker-favicons/rutor.ico" },
  rutracker: { abbreviation: "RT", favicon: "/tracker-favicons/rutracker.ico" },
};
export function TrackerTag({ tracker, variant: forcedVariant, decorative = false }: { tracker: TrackerKey; variant?: TrackerMarkerStyle; decorative?: boolean }) {
  const preferredVariant = useContext(TrackerMarkerStyleContext), name = useTrackerName()(tracker), known = TRACKER_MARKERS[tracker];
  // A tracker without marker assets gets a neutral letter badge in either style.
  const variant = known ? forcedVariant || preferredVariant : "abbreviations";
  const marker = !known ? name.slice(0, 2).toUpperCase() : variant === "icons" ? <img src={known.favicon} alt="" width="20" height="20" /> : known.abbreviation;
  return <span className={`tracker-tag tracker-tag--${variant} tracker-tag--${tracker}`} title={decorative ? undefined : name} role={decorative ? undefined : "img"} aria-label={decorative ? undefined : name}>{marker}</span>;
}
const BRAND_HEAD_PATH = "M123.5 20.21A9 9 0 0 1 132.5 20.21L219.1 70.21A9 9 0 0 1 223.6 78V178A9 9 0 0 1 219.1 185.79L132.5 235.79A9 9 0 0 1 123.5 235.79L36.9 185.79A9 9 0 0 1 32.4 178V78A9 9 0 0 1 36.9 70.21Z";
export function BrandMark({ size = 32, scanning = false }: { size?: number; scanning?: boolean }) {
  const id = `brand-${useId().replace(/[^\w-]/g, "")}`;
  return <svg className={scanning ? "brand-mark brand-mark--scanning" : "brand-mark"} width={size} height={size} viewBox="0 0 256 256" aria-hidden="true" focusable="false">
    <defs><linearGradient id={`${id}-head`} x1="0.08" y1="0" x2="0.92" y2="1"><stop offset="0" stopColor="#22D3EE" /><stop offset="0.55" stopColor="#4F7DF3" /><stop offset="1" stopColor="#7C3AED" /></linearGradient><radialGradient id={`${id}-glow`}><stop offset="0" stopColor="#FBBF24" stopOpacity="0.7" /><stop offset="1" stopColor="#FBBF24" stopOpacity="0" /></radialGradient><clipPath id={`${id}-visor`}><rect x="55" y="95" width="146" height="38" rx="19" /></clipPath></defs>
    <path d={BRAND_HEAD_PATH} fill={`url(#${id}-head)`} /><rect x="55" y="95" width="146" height="38" rx="19" fill="#0B1020" /><g clipPath={`url(#${id}-visor)`}><g className="brand-mark__light"><ellipse className="brand-mark__glow" cx="128" cy="114" rx="64" ry="22" fill={`url(#${id}-glow)`} /><rect x="109" y="107" width="38" height="14" rx="7" fill="#FBBF24" /></g></g>
  </svg>;
}
