import { useEffect } from "react";
import { Page } from "../components/UI";
import { errorMessage } from "../format";
import { useTrackers } from "../hooks/useTrackers";
import { useI18n } from "../i18n";
import type { Notify, User } from "../types";
import { AccountSection } from "./settings/AccountSection";
import { PreferencesSections } from "./settings/PreferencesSections";
import { SETTINGS_SECTIONS } from "./settings/SettingsSection";
import { TelegramSection } from "./settings/TelegramSection";
import { TrackerAccessSection } from "./settings/TrackerAccessSection";

export function Settings({ user, onUserChange, notify, accountFocusRequest = 0, onAccountFocused }: { user: User; onUserChange: (user: User) => void; notify: Notify; accountFocusRequest?: number; onAccountFocused?: () => void }) {
  const { t } = useI18n();
  const { trackers, reload: reloadTrackers } = useTrackers((error) => notify(errorMessage(error), "bad"));
  // A reload after following a shortcut renders the sections after the browser looked for the anchor.
  useEffect(() => { const id = decodeURIComponent(window.location.hash.slice(1)); if (SETTINGS_SECTIONS.some((section) => section.id === id)) document.getElementById(id)?.scrollIntoView?.(); }, []);
  return <Page title={t("Settings")} eyebrow={t("Preferences & access")} description={t("Personalize the appearance and source markers, and configure private tracker access and Telegram delivery.")}>
    <nav className="settings-shortcuts" aria-label={t("Settings sections")}>{SETTINGS_SECTIONS.map((item) => <a key={item.id} href={`#${item.id}`}>{t(item.title)}</a>)}</nav>
    <AccountSection user={user} notify={notify} focusRequest={accountFocusRequest} onFocused={onAccountFocused} />
    <PreferencesSections user={user} onUserChange={onUserChange} notify={notify} trackers={trackers} />
    <TelegramSection notify={notify} />
    <TrackerAccessSection trackers={trackers} reload={reloadTrackers} notify={notify} />
  </Page>;
}
