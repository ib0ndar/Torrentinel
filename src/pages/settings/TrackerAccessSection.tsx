import { useState } from "react";
import { api, jsonBody } from "../../api";
import { useDialog } from "../../components/Dialogs";
import { ListSkeleton, TrackerTag } from "../../components/UI";
import { errorMessage, isHttpUrl } from "../../format";
import { useI18n } from "../../i18n";
import type { Notify, Tracker, TrackerKey } from "../../types";
import { SettingsSection } from "./SettingsSection";

type TrackerDraft = { mirror: string; username: string; password: string };
type TrackerEdits = Partial<Record<TrackerKey, Partial<TrackerDraft>>>;
const savedDraft = (tracker: Tracker): TrackerDraft => ({ mirror: tracker.hasOverride ? tracker.baseUrl : "", username: tracker.username || "", password: "" });
const withoutEdit = (edits: TrackerEdits, key: TrackerKey) => { const { [key]: _discarded, ...rest } = edits; return rest; };

export function TrackerAccessSection({ trackers, reload, notify }: { trackers: Tracker[] | null; reload: () => Promise<Tracker[]>; notify: Notify }) {
  const { t } = useI18n(), dialog = useDialog();
  // Only edited tracker fields are kept, so reloading one row never discards unsaved edits in another.
  const [edits, setEdits] = useState<TrackerEdits>({}), [savingTracker, setSavingTracker] = useState<TrackerKey | null>(null);
  const discardTracker = (key: TrackerKey) => setEdits((current) => withoutEdit(current, key));
  const editTracker = (key: TrackerKey, change: Partial<TrackerDraft>) => setEdits((current) => ({ ...current, [key]: { ...current[key], ...change } }));
  const keepMirrorEdit = (key: TrackerKey) => setEdits((current) => current[key]?.mirror === undefined ? withoutEdit(current, key) : { ...current, [key]: { mirror: current[key].mirror } });
  async function saveTracker(tracker: Tracker, draft: TrackerDraft) {
    setSavingTracker(tracker.key);
    const payload: Record<string, unknown> = { baseUrl: draft.mirror.trim() || null };
    if (draft.username.trim()) payload.username = draft.username.trim();
    if (draft.password) payload.password = draft.password;
    try { await api(`/api/trackers/${tracker.key}/settings`, { method: "PUT", ...jsonBody(payload) }); await reload(); discardTracker(tracker.key); notify(t("{name} settings saved", { name: tracker.displayName })); }
    catch (error) { notify(errorMessage(error), "bad"); } finally { setSavingTracker(null); }
  }
  async function clearTrackerCredentials(tracker: Tracker) {
    if (!await dialog.confirm({ eyebrow: t("Tracker access"), title: t("Remove {name} login?", { name: tracker.displayName }), description: t("The encrypted username and password will be deleted. Any tracker checks that require authentication may stop working."), confirmLabel: t("Remove login"), tone: "danger" })) return;
    try { await api(`/api/trackers/${tracker.key}/settings`, { method: "PUT", ...jsonBody({ clearCredentials: true }) }); await reload(); keepMirrorEdit(tracker.key); notify(t("{name} login removed", { name: tracker.displayName })); }
    catch (error) { notify(errorMessage(error), "bad"); }
  }
  return <SettingsSection id="tracker-access" description={t("Each account has private mirrors and logins. Password fields stay blank after saving and only replace a password when you type a new one.")}>
    <div className="tracker-settings-list">{!trackers ? <ListSkeleton /> : trackers.map((tracker) => <TrackerAccessRow key={tracker.key} tracker={tracker} edit={edits[tracker.key]} saving={savingTracker === tracker.key}
      onEdit={(change) => editTracker(tracker.key, change)} onDiscard={() => discardTracker(tracker.key)} onSave={(draft) => void saveTracker(tracker, draft)} onClearCredentials={() => void clearTrackerCredentials(tracker)} />)}</div>
  </SettingsSection>;
}

function TrackerAccessRow({ tracker, edit, saving, onEdit, onDiscard, onSave, onClearCredentials }: {
  tracker: Tracker; edit?: Partial<TrackerDraft>; saving: boolean; onEdit: (change: Partial<TrackerDraft>) => void; onDiscard: () => void; onSave: (draft: TrackerDraft) => void; onClearCredentials: () => void;
}) {
  const { t } = useI18n();
  const saved = savedDraft(tracker), draft = { ...saved, ...edit };
  const dirty = draft.mirror !== saved.mirror || draft.username !== saved.username || draft.password !== "";
  // A login needs both a username and a password (typed now or already stored).
  const valid = Boolean(draft.username.trim()) === Boolean(draft.password || tracker.credentialsConfigured) && (!draft.mirror.trim() || isHttpUrl(draft.mirror.trim()));
  // Feed trackers poll a public feed and use a login only to recover coverage gaps.
  const configured = tracker.credentialsConfigured, feed = tracker.capabilities.ruleDiscovery === "feed", required = tracker.capabilities.authentication === "required";
  const summary = feed ? configured ? t("Public feed + authenticated gap recovery; login stored for {name}", { name: tracker.username || "" }) : t("Public feed monitoring; login enables coverage-gap recovery")
    : configured ? t("Login stored for {name}", { name: tracker.username || "" }) : t(required ? "Login required for polling" : "Login optional for this tracker");
  const state = t(feed ? configured ? "Recovery ready" : "Feed only" : configured ? "Secured" : required ? "Login missing" : "Public");
  return <form className="tracker-settings-row" aria-label={tracker.displayName} onSubmit={(event) => { event.preventDefault(); if (dirty && valid && !saving) onSave(draft); }}>
    <div className="integration-heading">
      <TrackerTag tracker={tracker.key} />
      <span><strong>{tracker.displayName}</strong><small>{summary}</small></span>
      <span className={`state ${configured || !required ? "state--good" : "state--pending"}`}>{state}</span>
    </div>
    <div className="tracker-settings-fields">
      <label className="settings-field settings-field--wide">
        <span>{t("Mirror override")}</span>
        <input type="url" value={draft.mirror} onChange={(event) => onEdit({ mirror: event.target.value })} placeholder={tracker.globalBaseUrl} />
      </label>
      <label className="settings-field">
        <span>{t("Username")}</span>
        <input value={draft.username} onChange={(event) => onEdit({ username: event.target.value })} autoComplete="off" />
      </label>
      <label className="settings-field">
        <span>{t("Password")}</span>
        <input type="password" value={draft.password} onChange={(event) => onEdit({ password: event.target.value })} placeholder={t(configured ? "Stored — type to replace" : "Password")} autoComplete="new-password" />
      </label>
    </div>
    <div className="integration-actions">
      <small>{tracker.hasOverride ? t("Personal mirror active") : t("Using global mirror {url}", { url: tracker.globalBaseUrl })}</small>
      {dirty && <span className="unsaved-hint">{t("Unsaved changes")}</span>}
      {dirty && <button type="button" className="text-button" disabled={saving} onClick={onDiscard}>{t("Discard")}</button>}
      {configured && <button type="button" className="text-button text-button--danger" onClick={onClearCredentials}>{t("Remove login")}</button>}
      <button type="submit" className="button button--quiet" disabled={saving || !dirty || !valid}>{t(saving ? "Saving…" : "Save settings")}</button>
    </div>
  </form>;
}
