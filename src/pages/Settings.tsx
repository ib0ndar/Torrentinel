import { useEffect } from "react";
import { Page } from "../components/UI";
import { errorMessage } from "../format";
import { useTrackers } from "../hooks/useTrackers";
import { useI18n } from "../i18n";
import { isPlainClick, type Navigate, SETTINGS_TABS, type SettingsTab, settingsPath } from "../routing";
import type { Notify, User } from "../types";
import { AccountSection } from "./settings/AccountSection";
import { PreferencesSections } from "./settings/PreferencesSections";
import { SETTINGS_SECTIONS, SETTINGS_TAB_LABELS } from "./settings/SettingsSection";
import { TelegramSection } from "./settings/TelegramSection";
import { TrackerAccessSection } from "./settings/TrackerAccessSection";

// Tabs are separate addresses like Administration's, so the tab bar is navigation (links), not an ARIA tablist.
export function Settings({ user, onUserChange, notify, tab = "account", navigate, accountFocusRequest = 0, onAccountFocused }: { user: User; onUserChange: (user: User) => void; notify: Notify; tab?: SettingsTab; navigate?: Navigate; accountFocusRequest?: number; onAccountFocused?: () => void }) {
  const { t } = useI18n();
  const { trackers, reload: reloadTrackers } = useTrackers((error) => notify(errorMessage(error), "bad"));
  // A section anchor (#appearance) scrolls once its tab has rendered, including after a reload.
  useEffect(() => { const id = decodeURIComponent(window.location.hash.slice(1)); if (SETTINGS_SECTIONS.some((section) => section.id === id && section.tab === tab)) document.getElementById(id)?.scrollIntoView?.(); }, [tab]);
  const tabs = <nav className="page-tabs" aria-label={t("Settings sections")}>{SETTINGS_TABS.map((name) => {
    const href = settingsPath(name);
    return <a key={name} href={href} aria-current={tab === name ? "page" : undefined} className={tab === name ? "page-tab page-tab--active" : "page-tab"} onClick={(event) => { if (!navigate || !isPlainClick(event)) return; event.preventDefault(); navigate(href); }}>{t(SETTINGS_TAB_LABELS[name])}</a>;
  })}</nav>;
  return <Page title={t("Settings")} eyebrow={t("Preferences & access")} description={t("Personalize the appearance and source markers, and configure private tracker access and Telegram delivery.")} navigation={tabs}>
    {tab === "account" && <AccountSection user={user} notify={notify} focusRequest={accountFocusRequest} onFocused={onAccountFocused} />}
    {tab === "preferences" && <PreferencesSections user={user} onUserChange={onUserChange} notify={notify} trackers={trackers} />}
    {tab === "telegram" && <TelegramSection notify={notify} />}
    {tab === "trackers" && <TrackerAccessSection trackers={trackers} reload={reloadTrackers} notify={notify} />}
  </Page>;
}
