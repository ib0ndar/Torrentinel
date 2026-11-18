import { type FormEvent, useEffect, useState } from "react";
import { api, jsonBody } from "../../api";
import { ListSkeleton } from "../../components/UI";
import { errorMessage } from "../../format";
import { useI18n } from "../../i18n";
import type { Notify } from "../../types";
import { SettingsSection } from "./SettingsSection";

const labels = {
  releases: "New rule matches", torrent: "Torrent and magnet changes",
  appearance: "Title and cover changes", metadata: "Other metadata changes",
} as const;
const modes = { immediate: "Immediately", digest: "Daily digest", off: "Off" } as const;
type Preferences = Record<keyof typeof labels, keyof typeof modes>;

export function TelegramPreferences({ notify }: { notify: Notify }) {
  const { t } = useI18n();
  const [preferences, setPreferences] = useState<Preferences | null>(null);
  const [saved, setSaved] = useState<Preferences | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void api<{ preferences: Preferences }>("/api/telegram/preferences", { signal: controller.signal }).then(({ preferences }) => {
      if (!controller.signal.aborted) { setPreferences(preferences); setSaved(preferences); }
    }).catch((error) => { if (!controller.signal.aborted) notify(errorMessage(error), "bad"); });
    return () => controller.abort();
  }, [notify]);
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!preferences || busy) return;
    setBusy(true);
    try {
      const result = await api<{ preferences: Preferences }>("/api/telegram/preferences", { method: "PUT", ...jsonBody(preferences) });
      setPreferences(result.preferences); setSaved(result.preferences);
      notify(t("Telegram preferences saved"));
    } catch (error) { notify(errorMessage(error), "bad"); } finally { setBusy(false); }
  }
  const categories = Object.keys(labels) as (keyof Preferences)[];
  return <SettingsSection id="telegram-preferences" description={t("Applies to new changes. Digests are scheduled for 09:00 UTC. All changes appear in Activity.")}>
    {!preferences ? <ListSkeleton /> : <form className="settings-control settings-control--preferences feature-form" onSubmit={save}>
      {categories.map((key) => <label key={key} className="settings-field">
        <span>{t(labels[key])}</span>
        <select value={preferences[key]} disabled={busy} onChange={(event) => setPreferences({ ...preferences, [key]: event.target.value })}>
          {Object.entries(modes).map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}
        </select>
      </label>)}
      <div className="inline-actions"><button className="button button--primary" disabled={busy || categories.every((key) => preferences[key] === saved?.[key])}>{t("Save changes")}</button></div>
    </form>}
  </SettingsSection>;
}
