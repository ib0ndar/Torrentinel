import { type FormEvent, type ReactNode, type Ref, useCallback, useEffect, useRef, useState } from "react";
import { api, jsonBody } from "../api";
import { useDialog } from "../components/Dialogs";
import { Icon } from "../components/Icon";
import { ListSkeleton, Page, TrackerTag } from "../components/UI";
import { errorMessage, isHttpUrl, relativeTime } from "../format";
import { useI18n } from "../i18n";
import { applyTheme, THEME_CHOICES, type ThemeId } from "../theme";
import type { Notify, TelegramStatus, ThemePreference, Tracker, TrackerKey, TrackerMarkerStyle, User } from "../types";
import { PAGE_SIZE_OPTIONS } from "../types";

type TrackerDraft = { mirror: string; username: string; password: string };
const MINIMUM_PASSWORD_LENGTH = 8;
// Stable anchors for the shortcuts; "auto" sections save on change, the others with their own button.
const SECTIONS = [
  { id: "account", title: "Account", auto: false }, { id: "language", title: "Language", auto: true }, { id: "appearance", title: "Appearance", auto: true },
  { id: "pagination", title: "Pagination", auto: true }, { id: "source-markers", title: "Source markers", auto: true },
  { id: "telegram-bot", title: "Telegram bot", auto: false }, { id: "tracker-access", title: "Tracker access", auto: false },
] as const;
type SectionId = (typeof SECTIONS)[number]["id"];
const savedDraft = (tracker: Tracker): TrackerDraft => ({ mirror: tracker.hasOverride ? tracker.baseUrl : "", username: tracker.username || "", password: "" });

export function Settings({ user, onUserChange, notify, accountFocusRequest = 0, onAccountFocused }: { user: User; onUserChange: (user: User) => void; notify: Notify; accountFocusRequest?: number; onAccountFocused?: () => void }) {
  const { t } = useI18n(), dialog = useDialog();
  const [telegram, setTelegram] = useState<TelegramStatus | null>(null), [link, setLink] = useState<{ code: string; expiresAt: string; deepLink?: string } | null>(null);
  // Only edited tracker fields are kept, so reloading one row never discards unsaved edits in another.
  const [trackers, setTrackers] = useState<Tracker[]>([]), [trackersLoaded, setTrackersLoaded] = useState(false), [edits, setEdits] = useState<Partial<Record<TrackerKey, Partial<TrackerDraft>>>>({}), [savingTracker, setSavingTracker] = useState<TrackerKey | null>(null);
  const [botToken, setBotToken] = useState(""), [telegramBusy, setTelegramBusy] = useState(false), [markerBusy, setMarkerBusy] = useState(false), [preferenceBusy, setPreferenceBusy] = useState(false);
  const loadTelegram = useCallback(async () => setTelegram((await api<{ telegram: TelegramStatus }>("/api/telegram")).telegram), []);
  const loadTrackers = useCallback(async () => { setTrackers((await api<{ trackers: Tracker[] }>("/api/trackers")).trackers); setTrackersLoaded(true); }, []);
  useEffect(() => { void Promise.all([loadTelegram(), loadTrackers()]).catch((error) => notify(errorMessage(error), "bad")); }, [loadTelegram, loadTrackers, notify]);
  useEffect(() => {
    if (!telegram?.configured || telegram.linked) return;
    const interval = window.setInterval(() => {
      void api<{ telegram: TelegramStatus }>("/api/telegram").then((result) => setTelegram(result.telegram)).catch(() => undefined);
      setLink((current) => current && new Date(current.expiresAt).getTime() <= Date.now() ? null : current);
    }, 5_000);
    return () => window.clearInterval(interval);
  }, [telegram?.configured, telegram?.linked]);
  // A reload after following a shortcut renders the sections after the browser looked for the anchor.
  useEffect(() => { const id = decodeURIComponent(window.location.hash.slice(1)); if (SECTIONS.some((section) => section.id === id)) document.getElementById(id)?.scrollIntoView?.(); }, []);
  async function savePreference(input: Partial<Pick<User, "language" | "paginationEnabled" | "pageSize" | "theme">>): Promise<boolean> {
    setPreferenceBusy(true);
    try { const result = await api<{ user: User }>("/api/settings/preferences", { method: "PUT", ...jsonBody(input) }); onUserChange(result.user); notify(t("Preference saved")); return true; }
    catch (error) { notify(errorMessage(error), "bad"); return false; } finally { setPreferenceBusy(false); }
  }
  async function setTheme(theme: ThemePreference) {
    if (preferenceBusy || theme === user.theme) return;
    applyTheme(theme);
    if (!await savePreference({ theme })) applyTheme(user.theme);
  }
  async function generateLink() {
    try { const result = await api<{ link: typeof link }>("/api/telegram/link-code", { method: "POST" }); setLink(result.link); }
    catch (error) { notify(errorMessage(error), "bad"); }
  }
  async function configureBot(event: FormEvent) {
    event.preventDefault();
    if (!botToken.trim() || telegramBusy) return;
    setTelegramBusy(true);
    try {
      const result = await api<{ telegram: TelegramStatus }>("/api/telegram/bot", { method: "POST", ...jsonBody({ token: botToken }) });
      setTelegram(result.telegram); setBotToken(""); setLink(null); notify(result.telegram.botUsername ? t("@{name} configured", { name: result.telegram.botUsername }) : t("Telegram bot configured"));
    } catch (error) { notify(errorMessage(error), "bad"); } finally { setTelegramBusy(false); }
  }
  async function removeBot() {
    if (!await dialog.confirm({ eyebrow: t("Telegram delivery"), title: t("Remove Telegram bot?"), description: t("This removes the stored bot token and unlinks the connected chat. Telegram notifications will stop until a bot is configured again."), confirmLabel: t("Remove bot"), tone: "danger" })) return;
    setTelegramBusy(true);
    try { await api("/api/telegram/bot", { method: "DELETE" }); setBotToken(""); setLink(null); await loadTelegram(); notify(t("Telegram bot removed")); }
    catch (error) { notify(errorMessage(error), "bad"); } finally { setTelegramBusy(false); }
  }
  async function unlink() {
    if (!await dialog.confirm({ eyebrow: t("Telegram delivery"), title: t("Unlink this chat?"), description: t("Notifications to the connected Telegram chat will stop. The bot token remains stored and you can link a chat again later."), confirmLabel: t("Unlink chat"), tone: "danger" })) return;
    try { await api("/api/telegram", { method: "DELETE" }); setLink(null); await loadTelegram(); notify(t("Telegram unlinked")); }
    catch (error) { notify(errorMessage(error), "bad"); }
  }
  const discard = (current: typeof edits, key: TrackerKey) => { const { [key]: _discarded, ...rest } = current; return rest; };
  const discardTracker = (key: TrackerKey) => setEdits((current) => discard(current, key));
  const editTracker = (key: TrackerKey, change: Partial<TrackerDraft>) => setEdits((current) => ({ ...current, [key]: { ...current[key], ...change } }));
  const keepMirrorEdit = (key: TrackerKey) => setEdits((current) => current[key]?.mirror === undefined ? discard(current, key) : { ...current, [key]: { mirror: current[key].mirror } });
  async function saveTracker(tracker: Tracker, draft: TrackerDraft) {
    setSavingTracker(tracker.key);
    const payload: Record<string, unknown> = { baseUrl: draft.mirror.trim() || null };
    if (draft.username.trim()) payload.username = draft.username.trim();
    if (draft.password) payload.password = draft.password;
    try { await api(`/api/trackers/${tracker.key}/settings`, { method: "PUT", ...jsonBody(payload) }); await loadTrackers(); discardTracker(tracker.key); notify(t("{name} settings saved", { name: tracker.displayName })); }
    catch (error) { notify(errorMessage(error), "bad"); } finally { setSavingTracker(null); }
  }
  async function clearTrackerCredentials(tracker: Tracker) {
    if (!await dialog.confirm({ eyebrow: t("Tracker access"), title: t("Remove {name} login?", { name: tracker.displayName }), description: t("The encrypted username and password will be deleted. Any tracker checks that require authentication may stop working."), confirmLabel: t("Remove login"), tone: "danger" })) return;
    try { await api(`/api/trackers/${tracker.key}/settings`, { method: "PUT", ...jsonBody({ clearCredentials: true }) }); await loadTrackers(); keepMirrorEdit(tracker.key); notify(t("{name} login removed", { name: tracker.displayName })); }
    catch (error) { notify(errorMessage(error), "bad"); }
  }
  async function setMarkerStyle(trackerMarkerStyle: TrackerMarkerStyle) {
    if (markerBusy || trackerMarkerStyle === user.trackerMarkerStyle) return;
    setMarkerBusy(true);
    try { const result = await api<{ user: User }>("/api/settings/source-markers", { method: "PUT", ...jsonBody({ trackerMarkerStyle }) }); onUserChange(result.user); notify(t("Source marker preference saved")); }
    catch (error) { notify(errorMessage(error), "bad"); } finally { setMarkerBusy(false); }
  }
  const section = (id: SectionId, control: ReactNode, description?: string) => {
    const { title, auto } = SECTIONS.find((item) => item.id === id)!;
    return <section id={id} className="settings-section settings-section--top" aria-labelledby={`${id}-heading`}><div className="settings-copy"><h2 id={`${id}-heading`}>{t(title)}</h2><span className="save-note"><Icon name={auto ? "check" : "edit"} size={13} />{t(auto ? "Saved automatically" : "Save to apply")}</span>{description && <p>{description}</p>}</div>{control}</section>;
  };
  return <Page title={t("Settings")} eyebrow={t("Preferences & access")} description={t("Personalize the appearance and source markers, and configure private tracker access and Telegram delivery.")}>
    <nav className="settings-shortcuts" aria-label={t("Settings sections")}>{SECTIONS.map((item) => <a key={item.id} href={`#${item.id}`}>{t(item.title)}</a>)}</nav>
    {section("account", <AccountForm user={user} notify={notify} focusRequest={accountFocusRequest} onFocused={onAccountFocused} />, t("Change the password for {name}. Other browsers and devices signed in to this account are signed out.", { name: user.username }))}
    {section("language", <div className="settings-control settings-control--preferences"><label className="settings-field"><span>{t("Interface language")}</span><select disabled={preferenceBusy} value={user.language} onChange={(event) => void savePreference({ language: event.target.value as User["language"] })}><option value="en">English</option><option value="ru">Русский</option></select></label></div>)}
    {section("appearance", <fieldset className="theme-options" disabled={preferenceBusy}><legend className="theme-options__legend">{t("Color theme")}</legend>{THEME_CHOICES.map((choice) => <label key={choice.id} className={user.theme === choice.id ? "theme-option theme-option--active" : "theme-option"}><input type="radio" name="theme" value={choice.id} checked={user.theme === choice.id} onChange={() => void setTheme(choice.id)} /><span className="theme-swatch" aria-hidden="true">{choice.id === "auto" ? <><ThemeSwatch theme="sentinel" /><ThemeSwatch theme="daylight" /></> : <ThemeSwatch theme={choice.id} />}</span><span className="theme-option__copy"><strong>{t(choice.label)}</strong><small>{t(choice.family)}</small></span>{user.theme === choice.id && <span className="theme-option__check" aria-hidden="true"><Icon name="check" size={20} /></span>}</label>)}</fieldset>, t("Choose the color theme for this account. Auto follows your device’s light or dark mode."))}
    {section("pagination", <div className="settings-control settings-control--preferences settings-control--pagination">
      <label className="check-line"><input type="checkbox" checked={user.paginationEnabled} disabled={preferenceBusy} onChange={(event) => void savePreference({ paginationEnabled: event.target.checked })} /><span><strong>{t("Enable pagination")}</strong></span></label>
      <label className="settings-field"><span>{t("Default entries per page")}</span><select disabled={preferenceBusy} value={user.pageSize} onChange={(event) => void savePreference({ pageSize: Number(event.target.value) })}>{PAGE_SIZE_OPTIONS.map((size) => <option key={size} value={size}>{size}</option>)}</select></label>
    </div>, t("Show collections in pages. Turn off to load all entries. Search and status filters always run on the server."))}
    {section("source-markers", <fieldset className="marker-options" disabled={markerBusy}><legend className="marker-options__legend">{t("Source marker style")}</legend>{(["icons", "abbreviations"] as const).map((style) => <label key={style} className={user.trackerMarkerStyle === style ? "marker-option marker-option--active" : "marker-option"}><input type="radio" name="tracker-marker-style" value={style} checked={user.trackerMarkerStyle === style} onChange={() => void setMarkerStyle(style)} /><span className="marker-option__copy"><strong>{t(style === "icons" ? "Website icons" : "Abbreviation badges")}</strong><small>{t(style === "icons" ? "Use each tracker’s published favicon" : "Use the RT, RU, and KZ letter markers")}</small></span><span className="marker-preview" aria-hidden="true">{(["kinozal", "rutor", "rutracker"] as TrackerKey[]).map((tracker) => <TrackerTag key={tracker} tracker={tracker} variant={style} decorative />)}</span></label>)}</fieldset>, t("Choose how trackers are identified throughout the monitor, details, settings, and diagnostics views."))}
    {section("telegram-bot", <div className="settings-control">{!telegram ? <ListSkeleton /> : <div className="telegram-setup">
      <div className="integration-heading"><span className="telegram-mark"><Icon name="send" /></span><span><strong>{telegram.configured ? `@${telegram.botUsername}` : t("No bot configured")}</strong><small>{t(telegram.configured ? "Token encrypted in the local database" : "BotFather issues the token used by Torrentinel")}</small></span><a className="button button--quiet" href="https://t.me/BotFather" target="_blank" rel="noreferrer"><Icon name="external" />{t("Create bot with BotFather")}</a></div>
      <form className="telegram-token" onSubmit={(event) => void configureBot(event)}>
        <label className="settings-field"><span>{t(telegram.configured ? "Replace bot token" : "Bot token")}</span><input type="password" value={botToken} onChange={(event) => setBotToken(event.target.value)} placeholder={t(telegram.configured ? "Stored securely — paste a token to replace" : "Paste the HTTP API token from BotFather")} autoComplete="new-password" /></label>
        <div className="integration-actions"><small>{t("The token is validated with Telegram before it is encrypted and saved.")}</small>{telegram.configured && <button type="button" className="text-button text-button--danger" disabled={telegramBusy} onClick={() => void removeBot()}>{t("Remove bot")}</button>}<button type="submit" className="button button--quiet" disabled={telegramBusy || !botToken.trim()}>{t(telegramBusy ? "Validating…" : telegram.configured ? "Replace token" : "Save bot")}</button></div>
      </form>
      {telegram.configured && (telegram.linked ? <div className="linked-account"><span className="status-dot status-dot--live" /><span><strong>{telegram.telegramUsername ? `@${telegram.telegramUsername}` : t("Telegram chat linked")}</strong><small>{t("Notifications are active through @{name}", { name: telegram.botUsername || "" })}</small></span><button className="button button--quiet" onClick={() => void unlink()}>{t("Unlink chat")}</button></div> : link ? <div className="link-code"><p>{t("Open @{name} and send /start {code}.", { name: telegram.botUsername || "", code: link.code })}</p><strong>{link.code}</strong>{link.deepLink && <a className="button button--primary" href={link.deepLink} target="_blank" rel="noreferrer"><Icon name="send" />{t("Open Telegram")}</a>}<small>{t("Expires {time}", { time: relativeTime(link.expiresAt) })}</small></div> : <div className="link-prompt"><span><strong>{t("Bot saved. Chat not linked.")}</strong><small>{t("Generate a one-time code to connect this Torrentinel account.")}</small></span><button className="button button--primary" onClick={() => void generateLink()}><Icon name="send" />{t("Link Telegram")}</button></div>)}
    </div>}</div>, t("Create a bot with BotFather, store its token securely, then link the private chat that should receive changes."))}
    {section("tracker-access", <div className="tracker-settings-list">{!trackersLoaded ? <ListSkeleton /> : trackers.map((tracker) => {
      const saved = savedDraft(tracker), draft = { ...saved, ...edits[tracker.key] }, saving = savingTracker === tracker.key;
      const dirty = draft.mirror !== saved.mirror || draft.username !== saved.username || draft.password !== "";
      // A login needs both a username and a password (typed now or already stored).
      const valid = Boolean(draft.username.trim()) === Boolean(draft.password || tracker.credentialsConfigured) && (!draft.mirror.trim() || isHttpUrl(draft.mirror.trim()));
      return <form className="tracker-settings-row" key={tracker.key} aria-label={tracker.displayName} onSubmit={(event) => { event.preventDefault(); if (dirty && valid && !saving) void saveTracker(tracker, draft); }}>
        <div className="integration-heading"><TrackerTag tracker={tracker.key} /><span><strong>{tracker.displayName}</strong><small>{tracker.key === "rutracker" ? tracker.credentialsConfigured ? t("Public feed + authenticated gap recovery; login stored for {name}", { name: tracker.username || "" }) : t("Public feed monitoring; login enables coverage-gap recovery") : tracker.credentialsConfigured ? t("Login stored for {name}", { name: tracker.username || "" }) : t(tracker.key === "kinozal" ? "Login required for polling" : "Login optional for this tracker")}</small></span><span className={`state ${tracker.credentialsConfigured || tracker.key !== "kinozal" ? "state--good" : "state--pending"}`}>{t(tracker.key === "rutracker" ? tracker.credentialsConfigured ? "Recovery ready" : "Feed only" : tracker.credentialsConfigured ? "Secured" : tracker.key === "kinozal" ? "Login missing" : "Public")}</span></div>
        <div className="tracker-settings-fields"><label className="settings-field settings-field--wide"><span>{t("Mirror override")}</span><input type="url" value={draft.mirror} onChange={(event) => editTracker(tracker.key, { mirror: event.target.value })} placeholder={tracker.globalBaseUrl} /></label><label className="settings-field"><span>{t("Username")}</span><input value={draft.username} onChange={(event) => editTracker(tracker.key, { username: event.target.value })} autoComplete="off" /></label><label className="settings-field"><span>{t("Password")}</span><input type="password" value={draft.password} onChange={(event) => editTracker(tracker.key, { password: event.target.value })} placeholder={t(tracker.credentialsConfigured ? "Stored — type to replace" : "Password")} autoComplete="new-password" /></label></div>
        <div className="integration-actions"><small>{tracker.hasOverride ? t("Personal mirror active") : t("Using global mirror {url}", { url: tracker.globalBaseUrl })}</small>{dirty && <span className="unsaved-hint">{t("Unsaved changes")}</span>}{dirty && <button type="button" className="text-button" disabled={saving} onClick={() => discardTracker(tracker.key)}>{t("Discard")}</button>}{tracker.credentialsConfigured && <button type="button" className="text-button text-button--danger" onClick={() => void clearTrackerCredentials(tracker)}>{t("Remove login")}</button>}<button type="submit" className="button button--quiet" disabled={saving || !dirty || !valid}>{t(saving ? "Saving…" : "Save settings")}</button></div>
      </form>;
    })}</div>, t("Each account has private mirrors and logins. Password fields stay blank after saving and only replace a password when you type a new one."))}
  </Page>;
}
// Self-service password change; the server keeps this session and signs out the account's other sessions.
function AccountForm({ user, notify, focusRequest, onFocused }: { user: User; notify: Notify; focusRequest: number; onFocused?: () => void }) {
  const { t } = useI18n();
  const [currentPassword, setCurrentPassword] = useState(""), [newPassword, setNewPassword] = useState(""), [confirm, setConfirm] = useState(""), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const currentRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!focusRequest) return;
    document.getElementById("account")?.scrollIntoView?.({ block: "start" });
    currentRef.current?.focus({ preventScroll: true });
    onFocused?.();
  }, [focusRequest]); // onFocused only resets the request.
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (newPassword.length < MINIMUM_PASSWORD_LENGTH) return setError(t("The new password must have at least {count} characters", { count: MINIMUM_PASSWORD_LENGTH }));
    if (newPassword !== confirm) return setError(t("New passwords do not match"));
    setError(""); setBusy(true);
    try {
      await api("/api/auth/change-password", { method: "POST", ...jsonBody({ currentPassword, newPassword }) });
      setCurrentPassword(""); setNewPassword(""); setConfirm(""); notify(t("Password changed"));
    } catch (failure) { setError(errorMessage(failure)); } finally { setBusy(false); }
  }
  const field = (label: string, value: string, change: (value: string) => void, autoComplete: string, ref?: Ref<HTMLInputElement>) =>
    <label className="settings-field"><span>{label}</span><input ref={ref} type="password" value={value} onChange={(event) => { change(event.target.value); setError(""); }} autoComplete={autoComplete} required maxLength={500} aria-invalid={error ? true : undefined} aria-describedby={error ? "account-error" : undefined} /></label>;
  return <form className="settings-control account-form" onSubmit={(event) => void submit(event)} noValidate>
    <input type="text" name="username" autoComplete="username" value={user.username} readOnly hidden />
    {field(t("Current password"), currentPassword, setCurrentPassword, "current-password", currentRef)}
    <div className="account-form__new">{field(t("New password"), newPassword, setNewPassword, "new-password")}{field(t("Confirm new password"), confirm, setConfirm, "new-password")}</div>
    {error && <p className="form-error" id="account-error" role="alert"><Icon name="alert" size={15} />{error}</p>}
    <div className="integration-actions"><small>{t("At least {count} characters", { count: MINIMUM_PASSWORD_LENGTH })}</small><button type="submit" className="button button--quiet" disabled={busy || !currentPassword || !newPassword || !confirm}>{t(busy ? "Saving…" : "Change password")}</button></div>
  </form>;
}
function ThemeSwatch({ theme }: { theme: ThemeId }) {
  return <span className="theme-swatch__face" data-theme={theme}><span><span className="theme-swatch__title" /><span className="theme-swatch__text" /><span className="theme-swatch__action" /></span></span>;
}
