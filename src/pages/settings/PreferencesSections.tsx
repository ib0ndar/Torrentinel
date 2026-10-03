import { useState } from "react";
import { api, jsonBody } from "../../api";
import { Icon } from "../../components/Icon";
import { TrackerTag } from "../../components/UI";
import { errorMessage } from "../../format";
import { useI18n } from "../../i18n";
import { applyTheme, THEME_CHOICES, type ThemeId } from "../../theme";
import type { Notify, ThemePreference, Tracker, TrackerMarkerStyle, User } from "../../types";
import { PAGE_SIZE_OPTIONS } from "../../types";
import { SettingsSection } from "./SettingsSection";

type Preferences = Partial<Pick<User, "language" | "paginationEnabled" | "pageSize" | "theme">>;

// Language, appearance, pagination and source markers save as soon as they change.
export function PreferencesSections({ user, onUserChange, notify, trackers }: { user: User; onUserChange: (user: User) => void; notify: Notify; trackers: Tracker[] | null }) {
  const { t } = useI18n();
  const [preferenceBusy, setPreferenceBusy] = useState(false), [markerBusy, setMarkerBusy] = useState(false);
  async function savePreference(input: Preferences): Promise<boolean> {
    setPreferenceBusy(true);
    try { const result = await api<{ user: User }>("/api/settings/preferences", { method: "PUT", ...jsonBody(input) }); onUserChange(result.user); notify(t("Preference saved")); return true; }
    catch (error) { notify(errorMessage(error), "bad"); return false; } finally { setPreferenceBusy(false); }
  }
  async function setTheme(theme: ThemePreference) {
    if (preferenceBusy || theme === user.theme) return;
    applyTheme(theme);
    if (!await savePreference({ theme })) applyTheme(user.theme);
  }
  async function setMarkerStyle(trackerMarkerStyle: TrackerMarkerStyle) {
    if (markerBusy || trackerMarkerStyle === user.trackerMarkerStyle) return;
    setMarkerBusy(true);
    try { const result = await api<{ user: User }>("/api/settings/source-markers", { method: "PUT", ...jsonBody({ trackerMarkerStyle }) }); onUserChange(result.user); notify(t("Source marker preference saved")); }
    catch (error) { notify(errorMessage(error), "bad"); } finally { setMarkerBusy(false); }
  }
  return <>
    <SettingsSection id="language">
      <div className="settings-control settings-control--preferences">
        <label className="settings-field">
          <span>{t("Interface language")}</span>
          <select disabled={preferenceBusy} value={user.language} onChange={(event) => void savePreference({ language: event.target.value as User["language"] })}>
            <option value="en">English</option>
            <option value="ru">Русский</option>
          </select>
        </label>
      </div>
    </SettingsSection>
    <SettingsSection id="appearance" description={t("Choose the color theme for this account. Auto follows your device’s light or dark mode.")}>
      <fieldset className="theme-options" disabled={preferenceBusy}>
        <legend className="theme-options__legend">{t("Color theme")}</legend>
        {THEME_CHOICES.map((choice) => <label key={choice.id} className={user.theme === choice.id ? "theme-option theme-option--active" : "theme-option"}>
          <input type="radio" name="theme" value={choice.id} checked={user.theme === choice.id} onChange={() => void setTheme(choice.id)} />
          <span className="theme-swatch" aria-hidden="true">{choice.id === "auto" ? <><ThemeSwatch theme="sentinel" /><ThemeSwatch theme="daylight" /></> : <ThemeSwatch theme={choice.id} />}</span>
          <span className="theme-option__copy"><strong>{t(choice.label)}</strong><small>{t(choice.family)}</small></span>
          {user.theme === choice.id && <span className="theme-option__check" aria-hidden="true"><Icon name="check" size={20} /></span>}
        </label>)}
      </fieldset>
    </SettingsSection>
    <SettingsSection id="pagination" description={t("Show collections in pages. Turn off to load all entries. Search and status filters always run on the server.")}>
      <div className="settings-control settings-control--preferences settings-control--pagination">
        <label className="check-line">
          <input type="checkbox" checked={user.paginationEnabled} disabled={preferenceBusy} onChange={(event) => void savePreference({ paginationEnabled: event.target.checked })} />
          <span><strong>{t("Enable pagination")}</strong></span>
        </label>
        <label className="settings-field">
          <span>{t("Default entries per page")}</span>
          <select disabled={preferenceBusy} value={user.pageSize} onChange={(event) => void savePreference({ pageSize: Number(event.target.value) })}>
            {PAGE_SIZE_OPTIONS.map((size) => <option key={size} value={size}>{size}</option>)}
          </select>
        </label>
      </div>
    </SettingsSection>
    <SettingsSection id="source-markers" description={t("Choose how trackers are identified throughout the monitor, details, settings, and diagnostics views.")}>
      <fieldset className="marker-options" disabled={markerBusy}>
        <legend className="marker-options__legend">{t("Source marker style")}</legend>
        {(["icons", "abbreviations"] as const).map((style) => <label key={style} className={user.trackerMarkerStyle === style ? "marker-option marker-option--active" : "marker-option"}>
          <input type="radio" name="tracker-marker-style" value={style} checked={user.trackerMarkerStyle === style} onChange={() => void setMarkerStyle(style)} />
          <span className="marker-option__copy">
            <strong>{t(style === "icons" ? "Website icons" : "Abbreviation badges")}</strong>
            <small>{t(style === "icons" ? "Use each tracker’s published favicon" : "Use the RT, RU, and KZ letter markers")}</small>
          </span>
          <span className="marker-preview" aria-hidden="true">{trackers?.map((tracker) => <TrackerTag key={tracker.key} tracker={tracker.key} variant={style} decorative />)}</span>
        </label>)}
      </fieldset>
    </SettingsSection>
  </>;
}

function ThemeSwatch({ theme }: { theme: ThemeId }) {
  return <span className="theme-swatch__face" data-theme={theme}><span><span className="theme-swatch__title" /><span className="theme-swatch__text" /><span className="theme-swatch__action" /></span></span>;
}
