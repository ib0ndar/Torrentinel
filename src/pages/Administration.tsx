import { type CSSProperties, type FormEvent, useCallback, useContext, useEffect, useState } from "react";
import { api, jsonBody } from "../api";
import { useDialog } from "../components/Dialogs";
import { CheckActivityContext } from "../components/contexts";
import { Icon } from "../components/Icon";
import { Drawer, DrawerActions, Field, Page, TrackerTag } from "../components/UI";
import { errorMessage, formatCoverageMinutes, formatPollInterval, isHttpUrl, nearestPollIntervalIndex, pollingCadence, POLL_INTERVAL_MARKERS, POLL_INTERVAL_OPTIONS, relativeTime, shortPollInterval } from "../format";
import { useI18n, translate as t } from "../i18n";
import { ADMIN_TABS, adminPath, type AdminTab, type DiagnosticsView, isPlainClick, type Navigate } from "../routing";
import { DiagnosticsPanel } from "./DiagnosticsPanel";
import type { AdminMirror, AdminUser, DiscoveryHealth, Notify, SchedulerStatus } from "../types";

const TAB_LABELS: Record<AdminTab, string> = { overview: "Overview", users: "Users", mirrors: "Mirrors", diagnostics: "Diagnostics" };

export function Admin({ notify, tab, diagnostics, pageSize, navigate }: { notify: Notify; tab: AdminTab; diagnostics: DiagnosticsView; pageSize: number; navigate: Navigate }) {
  useI18n();
  const dialog = useDialog(), trackCheck = useContext(CheckActivityContext);
  const [users, setUsers] = useState<AdminUser[]>([]), [mirrors, setMirrors] = useState<AdminMirror[]>([]), [status, setStatus] = useState<SchedulerStatus | null>(null), [discoveryHealth, setDiscoveryHealth] = useState<DiscoveryHealth[]>([]);
  const [intervalMinutes, setIntervalMinutes] = useState(60), [intervalIndex, setIntervalIndex] = useState(nearestPollIntervalIndex(60));
  const [createUser, setCreateUser] = useState(false), [polling, setPolling] = useState(false), [savingInterval, setSavingInterval] = useState(false), [diagnosticRevision, setDiagnosticRevision] = useState(0);
  const load = useCallback(async () => {
    const [userResult, mirrorResult, statusResult] = await Promise.all([api<{ users: AdminUser[] }>("/api/admin/users"), api<{ mirrors: AdminMirror[] }>("/api/admin/mirrors"), api<{ scheduler: SchedulerStatus; intervalMinutes: number; discoveryHealth: DiscoveryHealth[] }>("/api/system/status")]);
    setUsers(userResult.users); setMirrors(mirrorResult.mirrors); setStatus(statusResult.scheduler); setDiscoveryHealth(statusResult.discoveryHealth);
    setIntervalMinutes(statusResult.intervalMinutes); setIntervalIndex(nearestPollIntervalIndex(statusResult.intervalMinutes)); setDiagnosticRevision((value) => value + 1);
  }, []);
  useEffect(() => { void load().catch((error) => notify(errorMessage(error), "bad")); }, [load, notify]);
  async function poll() { setPolling(true); try { await trackCheck(api("/api/system/poll", { method: "POST" })); await load(); notify(t("Tracker poll completed")); } catch (error) { notify(errorMessage(error), "bad"); } finally { setPolling(false); } }
  async function toggleUser(user: AdminUser) { try { await api(`/api/admin/users/${user.id}`, { method: "PATCH", ...jsonBody({ disabled: !user.disabled }) }); await load(); notify(t(user.disabled ? "User enabled" : "User disabled")); } catch (error) { notify(errorMessage(error), "bad"); } }
  async function resetUser(user: AdminUser) {
    const password = await dialog.prompt({ eyebrow: t("User access"), title: t("Reset password for {name}", { name: user.username }), description: t("Set a temporary password. The user must replace it the next time they sign in."), inputLabel: t("Temporary password"), inputType: "password", autoComplete: "new-password", minLength: 8, maxLength: 500, confirmLabel: t("Reset password") });
    if (!password) return;
    try { await api(`/api/admin/users/${user.id}/reset-password`, { method: "POST", ...jsonBody({ password }) }); notify(t("Password reset; the user must change it at sign-in")); } catch (error) { notify(errorMessage(error), "bad"); }
  }
  async function updateMirror(mirror: AdminMirror, baseUrl: string, enabled: boolean): Promise<boolean> { try { await api(`/api/admin/mirrors/${mirror.trackerKey}`, { method: "PUT", ...jsonBody({ baseUrl, enabled }) }); await load(); notify(t("Global mirror updated")); return true; } catch (error) { notify(errorMessage(error), "bad"); return false; } }
  async function applyPollInterval() {
    setSavingInterval(true);
    try {
      const result = await api<{ scheduler: SchedulerStatus; intervalMinutes: number; discoveryHealth: DiscoveryHealth[] }>("/api/admin/settings/poll-interval", { method: "PUT", ...jsonBody({ minutes: POLL_INTERVAL_OPTIONS[intervalIndex] }) });
      setStatus(result.scheduler); setIntervalMinutes(result.intervalMinutes); setIntervalIndex(nearestPollIntervalIndex(result.intervalMinutes)); setDiscoveryHealth(result.discoveryHealth); notify(t("Polling interval set to {interval}", { interval: formatPollInterval(result.intervalMinutes) }));
    } catch (error) { notify(errorMessage(error), "bad"); } finally { setSavingInterval(false); }
  }
  const selectedInterval = POLL_INTERVAL_OPTIONS[intervalIndex], intervalChanged = selectedInterval !== intervalMinutes, intervalProgress = intervalIndex / (POLL_INTERVAL_OPTIONS.length - 1) * 100;
  const rutrackerHealth = discoveryHealth.find((health) => health.trackerKey === "rutracker");
  const selectedSafetyMargin = rutrackerHealth?.coverageMinutes ? Math.round(rutrackerHealth.coverageMinutes / selectedInterval * 10) / 10 : undefined;
  const coverageTone = !rutrackerHealth ? "state--pending" : rutrackerHealth.unresolvedGapSince || (selectedSafetyMargin !== undefined && selectedSafetyMargin < 1.5) ? "state--error" : selectedSafetyMargin !== undefined && selectedSafetyMargin < 2 ? "state--pending" : "state--good";
  // Sections are separate addresses, so the tab bar is navigation (links), not an ARIA tablist.
  const tabs = <nav className="page-tabs" aria-label={t("Administration sections")}>{ADMIN_TABS.map((name) => { const href = adminPath(name); return <a key={name} href={href} aria-current={tab === name ? "page" : undefined} className={tab === name ? "page-tab page-tab--active" : "page-tab"} onClick={(event) => { if (!isPlainClick(event)) return; event.preventDefault(); navigate(href); }}>{t(TAB_LABELS[name])}</a>; })}</nav>;
  return <Page title={t("Administration")} eyebrow={t("Local service")} description={t("Manage users, tracker access, polling, and diagnostic history.")} navigation={tabs} actions={tab === "users" ? <button className="button button--primary" onClick={() => setCreateUser(true)}><Icon name="plus" />{t("New user")}</button> : undefined}>
    {tab === "overview" && <>
      <section className="admin-strip"><div><span className={`status-dot ${status?.running ? "status-dot--live" : ""}`} /><span><strong>{status?.running ? t("Poll in progress") : pollingCadence(intervalMinutes)}</strong><small>{status?.lastFinishedAt ? t("Last completed {time}", { time: relativeTime(status.lastFinishedAt) }) : t("No completed poll yet")}</small></span></div><div className="run-metrics"><span><strong>{status?.checked || 0}</strong> {t("sources")}</span><span><strong>{status?.changed || 0}</strong> {t("changed")}</span><span><strong>{status?.errors || 0}</strong> {t("errors")}</span></div><button className="button button--quiet" disabled={polling || status?.running} onClick={poll}><Icon name="refresh" />{t(polling ? "Polling…" : "Run now")}</button></section>
      <section className="admin-schedule" aria-labelledby="poll-interval-heading"><div className="schedule-copy"><span className="schedule-icon"><Icon name="clock" /></span><span><strong id="poll-interval-heading">{t("Polling interval")}</strong><small>{t("One schedule for every user and tracker")}</small></span></div><div className="interval-control"><div className="interval-readout"><strong>{formatPollInterval(selectedInterval)}</strong><small>{intervalChanged ? t("Currently {interval}", { interval: formatPollInterval(intervalMinutes) }) : t("Active schedule")}</small></div><input className="interval-slider" type="range" min={0} max={POLL_INTERVAL_OPTIONS.length - 1} step={1} value={intervalIndex} aria-label={t("Polling interval")} aria-valuetext={formatPollInterval(selectedInterval)} style={{ "--interval-progress": `${intervalProgress}%` } as CSSProperties} onChange={(event) => setIntervalIndex(Number(event.target.value))} /><div className="interval-scale" aria-hidden="true">{POLL_INTERVAL_MARKERS.map((minutes, markerIndex) => <span key={minutes} className={markerIndex === 0 ? "scale-first" : markerIndex === POLL_INTERVAL_MARKERS.length - 1 ? "scale-last" : ""} style={{ left: `${POLL_INTERVAL_OPTIONS.indexOf(minutes) / (POLL_INTERVAL_OPTIONS.length - 1) * 100}%` }}>{shortPollInterval(minutes)}</span>)}</div></div><button className="button button--quiet" disabled={!intervalChanged || savingInterval} onClick={() => void applyPollInterval()}>{t(savingInterval ? "Applying…" : "Apply interval")}</button></section>
      <section className="coverage-strip" aria-labelledby="rutracker-coverage-heading"><span className="schedule-icon"><Icon name={coverageTone === "state--error" ? "alert" : "monitor"} /></span><span className="coverage-copy"><strong id="rutracker-coverage-heading">{t("RuTracker feed coverage")}</strong><small>{coverageDescription(rutrackerHealth, selectedSafetyMargin)}</small></span>{rutrackerHealth ? <div className="coverage-metrics"><span><strong>{rutrackerHealth.entryCount}</strong><small>{t("entries")}</small></span><span><strong>{rutrackerHealth.newEntryCount}</strong><small>{t(rutrackerHealth.coverageStatus === "baseline" ? "seeded" : "new")}</small></span><span><strong>{rutrackerHealth.overlapCount ?? "—"}</strong><small>{t("overlap")}</small></span><span><strong>{rutrackerHealth.coverageMinutes !== undefined ? formatCoverageMinutes(rutrackerHealth.coverageMinutes) : "—"}</strong><small>{t("window")}</small></span><span><strong>{selectedSafetyMargin !== undefined ? `${selectedSafetyMargin}×` : "—"}</strong><small>{t("margin")}</small></span></div> : <span className="coverage-empty">{t("Available after the first RuTracker rule poll")}</span>}<span className={`state ${coverageTone}`}>{t(rutrackerHealth?.unresolvedGapSince ? "Gap detected" : rutrackerHealth?.coverageStatus === "recovered" ? "Recovered" : rutrackerHealth?.coverageStatus === "baseline" ? "Baseline" : rutrackerHealth ? "Continuous" : "Pending")}</span></section>
    </>}
    {tab === "users" && <section className="table-section"><div className="section-heading"><div><h2>{t("Users")}</h2><p>{t("Collections and subscription data are isolated by account.")}</p></div><span>{users.length}</span></div><div className="data-table user-table"><div className="table-head"><span>{t("User")}</span><span>{t("Role")}</span><span>{t("Collections")}</span><span>{t("Subscriptions")}</span><span>{t("Status")}</span><span /></div>{users.map((user) => <div className="table-row" key={user.id}><span className="user-cell"><span className="avatar">{user.username[0].toUpperCase()}</span><span><strong>{user.username}</strong><small>{t("Created {time}", { time: relativeTime(user.createdAt) })}</small></span></span><span>{t(user.isAdmin ? "Administrator" : "Member")}</span><span>{user.collectionCount}</span><span>{user.subscriptionCount}</span><span><span className={`state ${user.disabled ? "state--error" : "state--good"}`}>{t(user.disabled ? "Disabled" : user.mustChangePassword ? "Password change" : "Active")}</span></span><span className="row-actions"><button className="text-button" onClick={() => void resetUser(user)}>{t("Reset password")}</button><button className="text-button" onClick={() => void toggleUser(user)}>{t(user.disabled ? "Enable" : "Disable")}</button></span></div>)}</div></section>}
    {tab === "mirrors" && <section className="table-section"><div className="section-heading"><div><h2>{t("Global mirrors")}</h2><p>{t("Defaults used unless a user has a personal override.")}</p></div></div><div className="mirror-admin">{mirrors.map((mirror) => <AdminMirrorRow key={`${mirror.trackerKey}:${mirror.baseUrl}:${mirror.enabled}`} mirror={mirror} onSave={updateMirror} />)}</div></section>}
    {tab === "diagnostics" && <DiagnosticsPanel revision={diagnosticRevision} notify={notify} view={diagnostics} pageSize={pageSize} onViewChange={(change, options) => navigate(adminPath("diagnostics", { ...diagnostics, ...change }), options)} />}
    {createUser && <CreateUser onClose={() => setCreateUser(false)} onCreated={async () => { setCreateUser(false); await load(); }} notify={notify} />}
  </Page>;
}
function coverageDescription(health: DiscoveryHealth | undefined, margin: number | undefined): string {
  if (!health) return t("The configured polling interval remains the actual tracker request interval.");
  if (health.coverageStatus === "baseline") return t("{count} entries were seeded as the initial sample. Overlap becomes available after the next poll.", { count: health.entryCount });
  if (health.unresolvedGapSince) return t("Continuity was lost {time}. Authenticated catch-up remains incomplete.", { time: relativeTime(health.unresolvedGapSince) });
  if (margin !== undefined && margin < 1.5) return t("The selected interval is too close to the current {window} rolling window.", { window: formatCoverageMinutes(health.coverageMinutes || 0) });
  if (margin !== undefined && margin < 2) return t("The selected interval leaves a narrow {margin}× margin against feed rollover.", { margin });
  return t("{count} entries currently span {window}; the selected interval leaves a {margin}× margin.", { count: health.entryCount, window: formatCoverageMinutes(health.coverageMinutes || 0), margin: margin ?? "—" });
}
// Save is only available while the row differs from the stored mirror; a successful save remounts it (new key) or resets it.
function AdminMirrorRow({ mirror, onSave }: { mirror: AdminMirror; onSave: (mirror: AdminMirror, baseUrl: string, enabled: boolean) => Promise<boolean> }) {
  useI18n();
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
  return <form className="mirror-row" aria-label={mirror.displayName} onSubmit={(event) => void submit(event)}><div><TrackerTag tracker={mirror.trackerKey} /><span><strong>{mirror.displayName}</strong><small>{t(mirror.enabled ? "Enabled" : "Disabled")}{dirty && <> · <span className="unsaved-hint">{t("Unsaved changes")}</span></>}</small></span></div><input type="url" aria-label={`${mirror.displayName} ${t("Mirror override")}`} value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} required /><label className="switch"><input type="checkbox" aria-label={`${mirror.displayName} ${t("Enabled")}`} checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /><span /></label><span className="mirror-row__actions">{dirty && <button type="button" className="text-button" disabled={saving} onClick={discard}>{t("Discard")}</button>}<button type="submit" className="button button--quiet" disabled={!dirty || !valid || saving}>{t(saving ? "Saving…" : "Save")}</button></span></form>;
}
function CreateUser({ onClose, onCreated, notify }: { onClose: () => void; onCreated: () => Promise<void>; notify: Notify }) {
  useI18n();
  const [username, setUsername] = useState(""), [password, setPassword] = useState(""), [isAdmin, setIsAdmin] = useState(false), [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) { event.preventDefault(); setBusy(true); try { await api("/api/admin/users", { method: "POST", ...jsonBody({ username, password, isAdmin }) }); await onCreated(); notify(t("User created")); } catch (error) { notify(errorMessage(error), "bad"); } finally { setBusy(false); } }
  return <Drawer title={t("New user")} subtitle={t("The account receives a private Inbox collection.")} onClose={onClose}><form onSubmit={submit}><Field label={t("Username")}><input value={username} onChange={(event) => setUsername(event.target.value)} autoFocus required /></Field><Field label={t("Temporary password")} hint={t("At least 8 characters")}><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} minLength={8} required /></Field><label className="check-line"><input type="checkbox" checked={isAdmin} onChange={(event) => setIsAdmin(event.target.checked)} /><span><strong>{t("Administrator")}</strong><small>{t("Can manage users, global mirrors, and polling.")}</small></span></label><DrawerActions onCancel={onClose} busy={busy} label={t("Create user")} /></form></Drawer>;
}
