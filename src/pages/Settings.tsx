import { useCallback, useEffect, useState } from "react";
import { api, jsonBody } from "../api";
import { useDialog } from "../components/Dialogs";
import { Icon } from "../components/Icon";
import { ListSkeleton, Page, TrackerTag } from "../components/UI";
import { errorMessage, relativeTime } from "../format";
import { useI18n } from "../i18n";
import { applyTheme, THEME_CHOICES, type ThemeId } from "../theme";
import type { Notify, TelegramStatus, ThemePreference, Tracker, TrackerKey, TrackerMarkerStyle, User } from "../types";
import { PAGE_SIZE_OPTIONS } from "../types";

type TrackerSettingsDraft = { mirror: string; username: string; password: string; saving: boolean };
export function Settings({ user, onUserChange, notify }: { user: User; onUserChange: (user: User) => void; notify: Notify }) {
  const { t } = useI18n(), dialog = useDialog();
  const [telegram, setTelegram] = useState<TelegramStatus | null>(null), [link, setLink] = useState<{ code: string; expiresAt: string; deepLink?: string } | null>(null);
  const [trackers, setTrackers] = useState<Tracker[]>([]), [drafts, setDrafts] = useState<Partial<Record<TrackerKey, TrackerSettingsDraft>>>({});
  const [botToken, setBotToken] = useState(""), [telegramBusy, setTelegramBusy] = useState(false), [markerBusy, setMarkerBusy] = useState(false), [preferenceBusy, setPreferenceBusy] = useState(false);
  const load = useCallback(async () => {
    const [telegramResult, trackerResult] = await Promise.all([api<{ telegram: TelegramStatus }>("/api/telegram"), api<{ trackers: Tracker[] }>("/api/trackers")]);
    setTelegram(telegramResult.telegram); setTrackers(trackerResult.trackers);
    setDrafts(Object.fromEntries(trackerResult.trackers.map((tracker) => [tracker.key, { mirror: tracker.hasOverride ? tracker.baseUrl : "", username: tracker.username || "", password: "", saving: false }])) as Record<TrackerKey, TrackerSettingsDraft>);
  }, []);
  useEffect(() => { void load().catch((error) => notify(errorMessage(error), "bad")); }, [load, notify]);
  useEffect(() => {
    if (!telegram?.configured || telegram.linked) return;
    const interval = window.setInterval(() => {
      void api<{ telegram: TelegramStatus }>("/api/telegram").then((result) => setTelegram(result.telegram)).catch(() => undefined);
      setLink((current) => current && new Date(current.expiresAt).getTime() <= Date.now() ? null : current);
    }, 5_000);
    return () => window.clearInterval(interval);
  }, [telegram?.configured, telegram?.linked]);
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
  async function configureBot() {
    if (!botToken.trim()) return;
    setTelegramBusy(true);
    try {
      const result = await api<{ telegram: TelegramStatus }>("/api/telegram/bot", { method: "POST", ...jsonBody({ token: botToken }) });
      setTelegram(result.telegram); setBotToken(""); setLink(null); notify(result.telegram.botUsername ? t("@{name} configured", { name: result.telegram.botUsername }) : t("Telegram bot configured"));
    } catch (error) { notify(errorMessage(error), "bad"); } finally { setTelegramBusy(false); }
  }
  async function removeBot() {
    if (!await dialog.confirm({ eyebrow: t("Telegram delivery"), title: t("Remove Telegram bot?"), description: t("This removes the stored bot token and unlinks the connected chat. Telegram notifications will stop until a bot is configured again."), confirmLabel: t("Remove bot"), tone: "danger" })) return;
    setTelegramBusy(true);
    try { await api("/api/telegram/bot", { method: "DELETE" }); setBotToken(""); setLink(null); await load(); notify(t("Telegram bot removed")); }
    catch (error) { notify(errorMessage(error), "bad"); } finally { setTelegramBusy(false); }
  }
  async function unlink() {
    if (!await dialog.confirm({ eyebrow: t("Telegram delivery"), title: t("Unlink this chat?"), description: t("Notifications to the connected Telegram chat will stop. The bot token remains stored and you can link a chat again later."), confirmLabel: t("Unlink chat"), tone: "danger" })) return;
    try { await api("/api/telegram", { method: "DELETE" }); setLink(null); await load(); notify(t("Telegram unlinked")); }
    catch (error) { notify(errorMessage(error), "bad"); }
  }
  async function saveTracker(tracker: Tracker) {
    const draft = drafts[tracker.key]; if (!draft) return;
    setDrafts((current) => ({ ...current, [tracker.key]: { ...draft, saving: true } }));
    const payload: Record<string, unknown> = { baseUrl: draft.mirror.trim() || null };
    if (draft.username.trim()) payload.username = draft.username.trim();
    if (draft.password) payload.password = draft.password;
    try { await api(`/api/trackers/${tracker.key}/settings`, { method: "PUT", ...jsonBody(payload) }); await load(); notify(t("{name} settings saved", { name: tracker.displayName })); }
    catch (error) { setDrafts((current) => ({ ...current, [tracker.key]: { ...draft, saving: false } })); notify(errorMessage(error), "bad"); }
  }
  async function clearTrackerCredentials(tracker: Tracker) {
    if (!await dialog.confirm({ eyebrow: t("Tracker access"), title: t("Remove {name} login?", { name: tracker.displayName }), description: t("The encrypted username and password will be deleted. Any tracker checks that require authentication may stop working."), confirmLabel: t("Remove login"), tone: "danger" })) return;
    try { await api(`/api/trackers/${tracker.key}/settings`, { method: "PUT", ...jsonBody({ clearCredentials: true }) }); await load(); notify(t("{name} login removed", { name: tracker.displayName })); }
    catch (error) { notify(errorMessage(error), "bad"); }
  }
  async function setMarkerStyle(trackerMarkerStyle: TrackerMarkerStyle) {
    if (markerBusy || trackerMarkerStyle === user.trackerMarkerStyle) return;
    setMarkerBusy(true);
    try { const result = await api<{ user: User }>("/api/settings/source-markers", { method: "PUT", ...jsonBody({ trackerMarkerStyle }) }); onUserChange(result.user); notify(t("Source marker preference saved")); }
    catch (error) { notify(errorMessage(error), "bad"); } finally { setMarkerBusy(false); }
  }
  return <Page title={t("Settings")} eyebrow={t("Preferences & access")} description={t("Personalize the appearance and source markers, and configure private tracker access and Telegram delivery.")}>
    <section className="settings-section settings-section--top"><div className="settings-copy"><h2>{t("Language")}</h2></div><div className="settings-control settings-control--preferences"><label className="settings-field"><span>{t("Interface language")}</span><select disabled={preferenceBusy} value={user.language} onChange={(event) => void savePreference({ language: event.target.value as User["language"] })}><option value="en">English</option><option value="ru">Русский</option></select></label></div></section>
    <section className="settings-section settings-section--top"><div className="settings-copy"><h2>{t("Appearance")}</h2><p>{t("Choose the color theme for this account. Auto follows your device’s light or dark mode.")}</p></div><fieldset className="theme-options" disabled={preferenceBusy}><legend className="theme-options__legend">{t("Color theme")}</legend>{THEME_CHOICES.map((choice) => <label key={choice.id} className={user.theme === choice.id ? "theme-option theme-option--active" : "theme-option"}><input type="radio" name="theme" value={choice.id} checked={user.theme === choice.id} onChange={() => void setTheme(choice.id)} /><span className="theme-swatch" aria-hidden="true">{choice.id === "auto" ? <><ThemeSwatch theme="sentinel" /><ThemeSwatch theme="daylight" /></> : <ThemeSwatch theme={choice.id} />}</span><span className="theme-option__copy"><strong>{t(choice.label)}</strong><small>{t(choice.family)}</small></span>{user.theme === choice.id && <span className="theme-option__check" aria-hidden="true"><Icon name="check" size={20} /></span>}</label>)}</fieldset></section>
    <section className="settings-section settings-section--top">
      <div className="settings-copy"><h2>{t("Pagination")}</h2><p>{t("Show collections in pages. Turn off to load all entries. Search and status filters always run on the server.")}</p></div>
      <div className="settings-control settings-control--preferences settings-control--pagination">
        <label className="check-line"><input type="checkbox" checked={user.paginationEnabled} disabled={preferenceBusy} onChange={(event) => void savePreference({ paginationEnabled: event.target.checked })} /><span><strong>{t("Enable pagination")}</strong></span></label>
        <label className="settings-field"><span>{t("Default entries per page")}</span><select disabled={preferenceBusy} value={user.pageSize} onChange={(event) => void savePreference({ pageSize: Number(event.target.value) })}>{PAGE_SIZE_OPTIONS.map((size) => <option key={size} value={size}>{size}</option>)}</select></label>
      </div>
    </section>
    <section className="settings-section settings-section--top"><div className="settings-copy"><h2>{t("Source markers")}</h2><p>{t("Choose how trackers are identified throughout the monitor, details, settings, and diagnostics views.")}</p></div><fieldset className="marker-options" disabled={markerBusy}><legend className="marker-options__legend">{t("Source marker style")}</legend>{(["icons", "abbreviations"] as const).map((style) => <label key={style} className={user.trackerMarkerStyle === style ? "marker-option marker-option--active" : "marker-option"}><input type="radio" name="tracker-marker-style" value={style} checked={user.trackerMarkerStyle === style} onChange={() => void setMarkerStyle(style)} /><span className="marker-option__copy"><strong>{t(style === "icons" ? "Website icons" : "Abbreviation badges")}</strong><small>{t(style === "icons" ? "Use each tracker’s published favicon" : "Use the RT, RU, and KZ letter markers")}</small></span><span className="marker-preview" aria-hidden="true">{(["kinozal", "rutor", "rutracker"] as TrackerKey[]).map((tracker) => <TrackerTag key={tracker} tracker={tracker} variant={style} decorative />)}</span></label>)}</fieldset></section>
    <section className="settings-section settings-section--top"><div className="settings-copy"><h2>{t("Telegram bot")}</h2><p>{t("Create a bot with BotFather, store its token securely, then link the private chat that should receive changes.")}</p></div><div className="settings-control">{!telegram ? <ListSkeleton /> : <div className="telegram-setup">
      <div className="integration-heading"><span className="telegram-mark"><Icon name="send" /></span><span><strong>{telegram.configured ? `@${telegram.botUsername}` : t("No bot configured")}</strong><small>{t(telegram.configured ? "Token encrypted in the local database" : "BotFather issues the token used by Torrentinel")}</small></span><a className="button button--quiet" href="https://t.me/BotFather" target="_blank" rel="noreferrer"><Icon name="external" />{t("Create bot with BotFather")}</a></div>
      <label className="settings-field"><span>{t(telegram.configured ? "Replace bot token" : "Bot token")}</span><input type="password" value={botToken} onChange={(event) => setBotToken(event.target.value)} placeholder={t(telegram.configured ? "Stored securely — paste a token to replace" : "Paste the HTTP API token from BotFather")} autoComplete="new-password" /></label>
      <div className="integration-actions"><small>{t("The token is validated with Telegram before it is encrypted and saved.")}</small>{telegram.configured && <button className="text-button text-button--danger" disabled={telegramBusy} onClick={() => void removeBot()}>{t("Remove bot")}</button>}<button className="button button--quiet" disabled={telegramBusy || !botToken.trim()} onClick={() => void configureBot()}>{t(telegramBusy ? "Validating…" : telegram.configured ? "Replace token" : "Save bot")}</button></div>
      {telegram.configured && (telegram.linked ? <div className="linked-account"><span className="status-dot status-dot--live" /><span><strong>{telegram.telegramUsername ? `@${telegram.telegramUsername}` : t("Telegram chat linked")}</strong><small>{t("Notifications are active through @{name}", { name: telegram.botUsername || "" })}</small></span><button className="button button--quiet" onClick={() => void unlink()}>{t("Unlink chat")}</button></div> : link ? <div className="link-code"><p>{t("Open @{name} and send /start {code}.", { name: telegram.botUsername || "", code: link.code })}</p><strong>{link.code}</strong>{link.deepLink && <a className="button button--primary" href={link.deepLink} target="_blank" rel="noreferrer"><Icon name="send" />{t("Open Telegram")}</a>}<small>{t("Expires {time}", { time: relativeTime(link.expiresAt) })}</small></div> : <div className="link-prompt"><span><strong>{t("Bot saved. Chat not linked.")}</strong><small>{t("Generate a one-time code to connect this Torrentinel account.")}</small></span><button className="button button--primary" onClick={() => void generateLink()}><Icon name="send" />{t("Link Telegram")}</button></div>)}
    </div>}</div></section>
    <section className="settings-section settings-section--top"><div className="settings-copy"><h2>{t("Tracker access")}</h2><p>{t("Each account has private mirrors and logins. Password fields stay blank after saving and only replace a password when you type a new one.")}</p></div><div className="tracker-settings-list">{trackers.map((tracker) => {
      const draft = drafts[tracker.key]; if (!draft) return <ListSkeleton key={tracker.key} />;
      return <section className="tracker-settings-row" key={tracker.key}>
        <div className="integration-heading"><TrackerTag tracker={tracker.key} /><span><strong>{tracker.displayName}</strong><small>{tracker.key === "rutracker" ? tracker.credentialsConfigured ? t("Public feed + authenticated gap recovery; login stored for {name}", { name: tracker.username || "" }) : t("Public feed monitoring; login enables coverage-gap recovery") : tracker.credentialsConfigured ? t("Login stored for {name}", { name: tracker.username || "" }) : t(tracker.key === "kinozal" ? "Login required for polling" : "Login optional for this tracker")}</small></span><span className={`state ${tracker.credentialsConfigured || tracker.key !== "kinozal" ? "state--good" : "state--pending"}`}>{t(tracker.key === "rutracker" ? tracker.credentialsConfigured ? "Recovery ready" : "Feed only" : tracker.credentialsConfigured ? "Secured" : tracker.key === "kinozal" ? "Login missing" : "Public")}</span></div>
        <div className="tracker-settings-fields"><label className="settings-field settings-field--wide"><span>{t("Mirror override")}</span><input type="url" value={draft.mirror} onChange={(event) => setDrafts((current) => ({ ...current, [tracker.key]: { ...draft, mirror: event.target.value } }))} placeholder={tracker.globalBaseUrl} /></label><label className="settings-field"><span>{t("Username")}</span><input value={draft.username} onChange={(event) => setDrafts((current) => ({ ...current, [tracker.key]: { ...draft, username: event.target.value } }))} autoComplete="off" /></label><label className="settings-field"><span>{t("Password")}</span><input type="password" value={draft.password} onChange={(event) => setDrafts((current) => ({ ...current, [tracker.key]: { ...draft, password: event.target.value } }))} placeholder={t(tracker.credentialsConfigured ? "Stored — type to replace" : "Password")} autoComplete="new-password" /></label></div>
        <div className="integration-actions"><small>{tracker.hasOverride ? t("Personal mirror active") : t("Using global mirror {url}", { url: tracker.globalBaseUrl })}</small>{tracker.credentialsConfigured && <button className="text-button text-button--danger" onClick={() => void clearTrackerCredentials(tracker)}>{t("Remove login")}</button>}<button className="button button--quiet" disabled={draft.saving || Boolean(draft.username.trim()) !== Boolean(draft.password || tracker.credentialsConfigured)} onClick={() => void saveTracker(tracker)}>{t(draft.saving ? "Saving…" : "Save settings")}</button></div>
      </section>;
    })}</div></section>
  </Page>;
}
function ThemeSwatch({ theme }: { theme: ThemeId }) {
  return <span className="theme-swatch__face" data-theme={theme}><span><span className="theme-swatch__title" /><span className="theme-swatch__text" /><span className="theme-swatch__action" /></span></span>;
}
