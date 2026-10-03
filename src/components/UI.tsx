import { type ReactNode, useContext, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon, type IconName } from "./Icon";
import { TrackerMarkerStyleContext } from "./contexts";
import { trackerName } from "../format";
import { useI18n } from "../i18n";
import type { SubscriptionType, TrackerKey, TrackerMarkerStyle } from "../types";

export function Page({ title, eyebrow, description, actions, navigation, children }: { title: string; eyebrow: string; description: string; actions?: ReactNode; navigation?: ReactNode; children: ReactNode }) {
  return <main className="page"><header className={navigation ? "page-header page-header--navigation" : "page-header"}><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p>{description}</p></div>{actions}</header>{navigation}<div className="page-body">{children}</div></main>;
}
export function Drawer({ title, subtitle, onClose, wide = false, extraWide = false, headerMedia, children }: { title: string; subtitle: string; onClose: () => void; wide?: boolean; extraWide?: boolean; headerMedia?: ReactNode; children: ReactNode }) {
  const { t } = useI18n();
  useEffect(() => { const key = (event: KeyboardEvent) => event.key === "Escape" && onClose(); window.addEventListener("keydown", key); return () => window.removeEventListener("keydown", key); }, [onClose]);
  // Render outside the animated application stage: its stacking/transform
  // context must not put fixed drawers behind mobile navigation.
  return createPortal(<div className="drawer-layer" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><aside className={`drawer ${wide ? "drawer--wide" : ""} ${extraWide ? "drawer--details" : ""}`} role="dialog" aria-modal="true" aria-label={title}><header><div className={`drawer-heading ${headerMedia ? "drawer-heading--with-media" : ""}`}>{headerMedia}<div className="drawer-heading__copy"><p className="eyebrow">{subtitle}</p><h2>{title}</h2></div></div><button className="icon-button" onClick={onClose} aria-label={t("Close")}><Icon name="close" /></button></header><div className="drawer-body">{children}</div></aside></div>, document.body);
}
export function DrawerActions({ onCancel, busy, label, disabled = false }: { onCancel: () => void; busy: boolean; label: string; disabled?: boolean }) {
  const { t } = useI18n();
  return <div className="drawer-actions"><button type="button" className="button button--quiet" onClick={onCancel}>{t("Cancel")}</button><button className="button button--primary" disabled={busy || disabled}>{busy ? t("Saving…") : label}</button></div>;
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
export function TrackerTag({ tracker, variant: forcedVariant, decorative = false }: { tracker: TrackerKey; variant?: TrackerMarkerStyle; decorative?: boolean }) {
  const preferredVariant = useContext(TrackerMarkerStyleContext), variant = forcedVariant || preferredVariant, name = trackerName(tracker);
  const marker = variant === "icons" ? <img src={`/tracker-favicons/${tracker}.ico`} alt="" width="20" height="20" /> : tracker === "rutracker" ? "RT" : tracker === "kinozal" ? "KZ" : "RU";
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
