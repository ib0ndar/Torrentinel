import type { ReactNode } from "react";
import { Icon } from "../../components/Icon";
import { useI18n } from "../../i18n";

// Stable anchors for the shortcuts; "auto" sections save on change, the others with their own button.
export const SETTINGS_SECTIONS = [
  { id: "account", title: "Account", auto: false }, { id: "language", title: "Language", auto: true }, { id: "appearance", title: "Appearance", auto: true },
  { id: "start-page", title: "Start page", auto: true }, { id: "pagination", title: "Pagination", auto: true }, { id: "source-markers", title: "Source markers", auto: true },
  { id: "telegram-bot", title: "Telegram bot", auto: false }, { id: "tracker-access", title: "Tracker access", auto: false },
] as const;
export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]["id"];

export function SettingsSection({ id, description, children }: { id: SettingsSectionId; description?: string; children: ReactNode }) {
  const { t } = useI18n();
  const { title, auto } = SETTINGS_SECTIONS.find((item) => item.id === id)!;
  return <section id={id} className="settings-section settings-section--top" aria-labelledby={`${id}-heading`}>
    <div className="settings-copy">
      <h2 id={`${id}-heading`}>{t(title)}</h2>
      <span className="save-note"><Icon name={auto ? "check" : "edit"} size={13} />{t(auto ? "Saved automatically" : "Save to apply")}</span>
      {description && <p>{description}</p>}
    </div>
    {children}
  </section>;
}
