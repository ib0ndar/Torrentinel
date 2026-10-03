import { type FormEvent, useState } from "react";
import { TrackerTag } from "../../components/UI";
import { isHttpUrl } from "../../format";
import { useI18n } from "../../i18n";
import type { AdminMirror } from "../../types";

type SaveMirror = (mirror: AdminMirror, baseUrl: string, enabled: boolean) => Promise<boolean>;

export function MirrorsTab({ mirrors, onSave }: { mirrors: AdminMirror[]; onSave: SaveMirror }) {
  const { t } = useI18n();
  return <section className="table-section">
    <div className="section-heading"><div><h2>{t("Global mirrors")}</h2><p>{t("Defaults used unless a user has a personal override.")}</p></div></div>
    <div className="mirror-admin">{mirrors.map((mirror) => <AdminMirrorRow key={`${mirror.trackerKey}:${mirror.baseUrl}:${mirror.enabled}`} mirror={mirror} onSave={onSave} />)}</div>
  </section>;
}

// Save is only available while the row differs from the stored mirror; a successful save remounts it (new key) or resets it.
function AdminMirrorRow({ mirror, onSave }: { mirror: AdminMirror; onSave: SaveMirror }) {
  const { t } = useI18n();
  const [baseUrl, setBaseUrl] = useState(mirror.baseUrl), [enabled, setEnabled] = useState(mirror.enabled), [saving, setSaving] = useState(false);
  const dirty = baseUrl !== mirror.baseUrl || enabled !== mirror.enabled, valid = isHttpUrl(baseUrl.trim());
  const discard = () => { setBaseUrl(mirror.baseUrl); setEnabled(mirror.enabled); };
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!dirty || !valid || saving) return;
    setSaving(true);
    if (await onSave(mirror, baseUrl.trim(), enabled)) discard();
    setSaving(false);
  }
  return <form className="mirror-row" aria-label={mirror.displayName} onSubmit={(event) => void submit(event)}>
    <div>
      <TrackerTag tracker={mirror.trackerKey} />
      <span><strong>{mirror.displayName}</strong><small>{t(mirror.enabled ? "Enabled" : "Disabled")}{dirty && <> · <span className="unsaved-hint">{t("Unsaved changes")}</span></>}</small></span>
    </div>
    <input type="url" aria-label={`${mirror.displayName} ${t("Mirror override")}`} value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} required />
    <label className="switch"><input type="checkbox" aria-label={`${mirror.displayName} ${t("Enabled")}`} checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /><span /></label>
    <span className="mirror-row__actions">
      {dirty && <button type="button" className="text-button" disabled={saving} onClick={discard}>{t("Discard")}</button>}
      <button type="submit" className="button button--quiet" disabled={!dirty || !valid || saving}>{t(saving ? "Saving…" : "Save")}</button>
    </span>
  </form>;
}
