import type { ReactNode } from "react";
import { Icon } from "../../components/Icon";
import { useI18n } from "../../i18n";
import type { SettingsTab } from "../../routing";

// Stable anchors (older links use /settings#id); "auto" sections save on change, the others with their own button.
// A tab's only section is named for what it holds, not after the tab.
export const SETTINGS_SECTIONS = [
  { id: "account", title: "Password", auto: false, tab: "account" }, { id: "language", title: "Language", auto: true, tab: "preferences" }, { id: "appearance", title: "Appearance", auto: true, tab: "preferences" },
  { id: "start-page", title: "Start page", auto: true, tab: "preferences" }, { id: "pagination", title: "Pagination", auto: true, tab: "preferences" }, { id: "source-markers", title: "Source markers", auto: true, tab: "preferences" },
  { id: "telegram-bot", title: "Bot and chat", auto: false, tab: "telegram" }, { id: "tracker-access", title: "Logins and mirrors", auto: false, tab: "trackers" },
] as const satisfies ReadonlyArray<{ id: string; title: string; auto: boolean; tab: SettingsTab }>;
export const SETTINGS_TAB_LABELS: Record<SettingsTab, string> = { account: "Account", preferences: "Preferences", telegram: "Telegram bot", trackers: "Tracker access" };
/** The tab holding a section, for addresses such as /settings#telegram-bot. */
export function settingsTabForSection(id: string): SettingsTab | undefined { return SETTINGS_SECTIONS.find((section) => section.id === id)?.tab; }
export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]["id"];

// Sections with a save button say so; the Preferences tab, which saves every change, says it once above its sections.
export function SettingsSection({ id, description, children }: { id: SettingsSectionId; description?: string; children: ReactNode }) {
  const { t } = useI18n();
  const { title, auto } = SETTINGS_SECTIONS.find((item) => item.id === id)!;
  return <section id={id} className="settings-section settings-section--top" aria-labelledby={`${id}-heading`}>
    <div className="settings-copy">
      <h2 id={`${id}-heading`}>{t(title)}</h2>
      {!auto && <span className="save-note"><Icon name="edit" size={13} />{t("Save to apply")}</span>}
      {description && <p>{description}</p>}
    </div>
    {children}
  </section>;
}
