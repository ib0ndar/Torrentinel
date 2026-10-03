import { useCallback, useContext, useEffect, useState } from "react";
import { api, jsonBody } from "../api";
import { useDialog } from "../components/Dialogs";
import { CheckActivityContext } from "../components/contexts";
import { Icon } from "../components/Icon";
import { Page } from "../components/UI";
import { errorMessage, formatPollInterval, nearestPollIntervalIndex, POLL_INTERVAL_OPTIONS } from "../format";
import { useTrackers } from "../hooks/useTrackers";
import { useI18n } from "../i18n";
import { ADMIN_TABS, adminPath, type AdminTab, type DiagnosticsView, isPlainClick, type Navigate } from "../routing";
import type { AdminMirror, AdminUser, DiscoveryHealth, Notify, SchedulerStatus } from "../types";
import { DiagnosticsTab } from "./admin/DiagnosticsTab";
import { MirrorsTab } from "./admin/MirrorsTab";
import { OverviewTab } from "./admin/OverviewTab";
import { CreateUser, UsersTab } from "./admin/UsersTab";

const TAB_LABELS: Record<AdminTab, string> = { overview: "Overview", users: "Users", mirrors: "Mirrors", diagnostics: "Diagnostics" };
type SystemStatus = { scheduler: SchedulerStatus; intervalMinutes: number; discoveryHealth: DiscoveryHealth[] };

// One load serves every tab, so switching tabs keeps the data and an unapplied polling interval.
export function Admin({ notify, tab, diagnostics, pageSize, navigate }: { notify: Notify; tab: AdminTab; diagnostics: DiagnosticsView; pageSize: number; navigate: Navigate }) {
  const { t } = useI18n();
  const dialog = useDialog(), trackCheck = useContext(CheckActivityContext), { reload: reloadTrackers } = useTrackers();
  const [users, setUsers] = useState<AdminUser[]>([]), [mirrors, setMirrors] = useState<AdminMirror[]>([]), [status, setStatus] = useState<SchedulerStatus | null>(null), [discoveryHealth, setDiscoveryHealth] = useState<DiscoveryHealth[]>([]);
  const [intervalMinutes, setIntervalMinutes] = useState(60), [intervalIndex, setIntervalIndex] = useState(nearestPollIntervalIndex(60));
  const [createUser, setCreateUser] = useState(false), [polling, setPolling] = useState(false), [savingInterval, setSavingInterval] = useState(false), [diagnosticRevision, setDiagnosticRevision] = useState(0);
  const load = useCallback(async () => {
    const [userResult, mirrorResult, statusResult] = await Promise.all([api<{ users: AdminUser[] }>("/api/admin/users"), api<{ mirrors: AdminMirror[] }>("/api/admin/mirrors"), api<SystemStatus>("/api/system/status")]);
    setUsers(userResult.users); setMirrors(mirrorResult.mirrors); setStatus(statusResult.scheduler); setDiscoveryHealth(statusResult.discoveryHealth);
    setIntervalMinutes(statusResult.intervalMinutes); setIntervalIndex(nearestPollIntervalIndex(statusResult.intervalMinutes)); setDiagnosticRevision((value) => value + 1);
  }, []);
  useEffect(() => { void load().catch((error) => notify(errorMessage(error), "bad")); }, [load, notify]);
  async function poll() {
    setPolling(true);
    try { await trackCheck(api("/api/system/poll", { method: "POST" })); await load(); notify(t("Tracker poll completed")); }
    catch (error) { notify(errorMessage(error), "bad"); } finally { setPolling(false); }
  }
  async function toggleUser(user: AdminUser) {
    try { await api(`/api/admin/users/${user.id}`, { method: "PATCH", ...jsonBody({ disabled: !user.disabled }) }); await load(); notify(t(user.disabled ? "User enabled" : "User disabled")); }
    catch (error) { notify(errorMessage(error), "bad"); }
  }
  async function resetUser(user: AdminUser) {
    const password = await dialog.prompt({ eyebrow: t("User access"), title: t("Reset password for {name}", { name: user.username }), description: t("Set a temporary password. The user must replace it the next time they sign in."), inputLabel: t("Temporary password"), inputType: "password", autoComplete: "new-password", minLength: 8, maxLength: 500, confirmLabel: t("Reset password") });
    if (!password) return;
    try { await api(`/api/admin/users/${user.id}/reset-password`, { method: "POST", ...jsonBody({ password }) }); notify(t("Password reset; the user must change it at sign-in")); }
    catch (error) { notify(errorMessage(error), "bad"); }
  }
  async function updateMirror(mirror: AdminMirror, baseUrl: string, enabled: boolean): Promise<boolean> {
    try {
      await api(`/api/admin/mirrors/${mirror.trackerKey}`, { method: "PUT", ...jsonBody({ baseUrl, enabled }) }); await load(); notify(t("Global mirror updated"));
      // The shared tracker list carries the global mirror shown in Settings > Tracker access.
      void reloadTrackers().catch(() => undefined);
      return true;
    } catch (error) { notify(errorMessage(error), "bad"); return false; }
  }
  async function applyPollInterval() {
    setSavingInterval(true);
    try {
      const result = await api<SystemStatus>("/api/admin/settings/poll-interval", { method: "PUT", ...jsonBody({ minutes: POLL_INTERVAL_OPTIONS[intervalIndex] }) });
      setStatus(result.scheduler); setIntervalMinutes(result.intervalMinutes); setIntervalIndex(nearestPollIntervalIndex(result.intervalMinutes)); setDiscoveryHealth(result.discoveryHealth); notify(t("Polling interval set to {interval}", { interval: formatPollInterval(result.intervalMinutes) }));
    } catch (error) { notify(errorMessage(error), "bad"); } finally { setSavingInterval(false); }
  }
  // Sections are separate addresses, so the tab bar is navigation (links), not an ARIA tablist.
  const tabs = <nav className="page-tabs" aria-label={t("Administration sections")}>{ADMIN_TABS.map((name) => {
    const href = adminPath(name);
    return <a key={name} href={href} aria-current={tab === name ? "page" : undefined} className={tab === name ? "page-tab page-tab--active" : "page-tab"} onClick={(event) => { if (!isPlainClick(event)) return; event.preventDefault(); navigate(href); }}>{t(TAB_LABELS[name])}</a>;
  })}</nav>;
  return <Page title={t("Administration")} eyebrow={t("Local service")} description={t("Manage users, tracker access, polling, and diagnostic history.")} navigation={tabs}
    actions={tab === "users" ? <button className="button button--primary" onClick={() => setCreateUser(true)}><Icon name="plus" />{t("New user")}</button> : undefined}>
    {tab === "overview" && <OverviewTab status={status} intervalMinutes={intervalMinutes} intervalIndex={intervalIndex} onIntervalIndexChange={setIntervalIndex} discoveryHealth={discoveryHealth}
      polling={polling} savingInterval={savingInterval} onPoll={() => void poll()} onApplyInterval={() => void applyPollInterval()} />}
    {tab === "users" && <UsersTab users={users} onResetPassword={(user) => void resetUser(user)} onToggle={(user) => void toggleUser(user)} />}
    {tab === "mirrors" && <MirrorsTab mirrors={mirrors} onSave={updateMirror} />}
    {tab === "diagnostics" && <DiagnosticsTab revision={diagnosticRevision} notify={notify} view={diagnostics} pageSize={pageSize} onViewChange={(change, options) => navigate(adminPath("diagnostics", { ...diagnostics, ...change }), options)} />}
    {createUser && <CreateUser onClose={() => setCreateUser(false)} onCreated={async () => { setCreateUser(false); await load(); }} notify={notify} />}
  </Page>;
}
