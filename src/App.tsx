import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import packageManifest from "../package.json";
import { api, ApiError, onPasswordChangeRequired, onSessionExpired, PASSWORD_CHANGE_MESSAGE, SESSION_EXPIRED_MESSAGE } from "./api";
import { useSchedulerStatus } from "./hooks/useSchedulerStatus";
import { useWorkspaceData } from "./hooks/useWorkspaceData";
import { CollectionsNavigation, NewCollection } from "./components/CollectionsNavigation";
import { DialogProvider } from "./components/Dialogs";
import { CheckActivityContext, TrackerMarkerStyleContext } from "./components/contexts";
import { Icon, type IconName } from "./components/Icon";
import { MenuButton, type MenuItem } from "./components/Menu";
import { BrandMark } from "./components/UI";
import { Activity } from "./pages/Activity";
import { Admin } from "./pages/Administration";
import { BootScreen, ChangePassword, Login } from "./pages/Authentication";
import { Settings } from "./pages/Settings";
import { Workspace } from "./pages/Workspace";
import { errorMessage, pollingCadence, relativeTime } from "./format";
import { setLanguage, useI18n } from "./i18n";
import { activityPath, adminPath, DEFAULT_MONITOR_VIEW, isPlainClick, monitorPath, type MonitorView, type Navigate, parseRoute, storeCollectionId, storedCollectionId } from "./routing";
import { applyTheme } from "./theme";
import type { Collection, Notify, User } from "./types";

type Toast = { id: number; message: string; tone: "good" | "bad" };
type BrowserLocation = { pathname: string; search: string };
const APP_VERSION = packageManifest.version;
const APP_REVISION = import.meta.env.VITE_APP_REVISION?.trim();
const RELEASE_URL = `https://github.com/ib0ndar/Torrentinel/releases/tag/v${APP_VERSION}`;

export default function App() {
  const { t } = useI18n();
  const [user, setUser] = useState<User | null | undefined>(undefined), [toast, setToast] = useState<Toast | null>(null), [lastUsername, setLastUsername] = useState("");
  const [location, navigate] = useBrowserLocation();
  const signedIn = useRef<string | null>(null);
  // Identical messages (e.g. several requests failing at once) refresh nothing and stack nothing.
  const notify = useCallback((message: string, tone: Toast["tone"] = "good") => setToast((current) => current && current.message === message && current.tone === tone ? current : { id: Date.now(), message, tone }), []);
  const updateUser = useCallback((value: User | null) => { signedIn.current = value?.username ?? null; if (value) { setLanguage(value.language); applyTheme(value.theme); } setUser(value); }, []);
  useEffect(() => onSessionExpired(() => {
    if (signedIn.current === null) return;
    setLastUsername(signedIn.current);
    updateUser(null);
    notify(t(SESSION_EXPIRED_MESSAGE), "bad");
  }), [notify, updateUser, t]);
  // The session is valid but the password must be changed first (an administrator reset also
  // ends sessions, so this is normally only reached by requests racing that change).
  useEffect(() => onPasswordChangeRequired(() => {
    if (signedIn.current === null) return;
    setUser((current) => current && !current.mustChangePassword ? { ...current, mustChangePassword: true } : current);
    notify(t(PASSWORD_CHANGE_MESSAGE), "bad");
  }), [notify, t]);
  async function signOut() { try { await api("/api/auth/logout", { method: "POST" }); updateUser(null); } catch (error) { notify(errorMessage(error), "bad"); } }
  useEffect(() => {
    api<{ user: User }>("/api/auth/me").then(({ user: current }) => updateUser(current)).catch((error) => {
      if (error instanceof ApiError && error.status === 401) updateUser(null); else notify(errorMessage(error), "bad");
    });
  }, [notify, updateUser]);
  useEffect(() => { if (!toast) return; const timer = window.setTimeout(() => setToast(null), 4_000); return () => window.clearTimeout(timer); }, [toast]);
  if (user === undefined) return <BootScreen />;
  if (!user) return <><Login onLogin={(value) => { setLastUsername(""); updateUser(value); }} notify={notify} initialUsername={lastUsername} />{toast && <div key={toast.id} className={`toast toast--${toast.tone}`}>{toast.message}</div>}</>;
  if (user.mustChangePassword) return <><ChangePassword user={user} onChanged={updateUser} onSignOut={() => void signOut()} notify={notify} />{toast && <div key={toast.id} className={`toast toast--${toast.tone}`}>{toast.message}</div>}</>;
  return <TrackerMarkerStyleContext.Provider value={user.trackerMarkerStyle}><DialogProvider><AppShell key={user.id} user={user} setUser={updateUser} notify={notify} location={location} navigate={navigate} />
    {toast && <div key={toast.id} className={`toast toast--${toast.tone}`}>{toast.message}</div>}
  </DialogProvider></TrackerMarkerStyleContext.Provider>;
}
function AppShell({ user, setUser, notify, location, navigate }: { user: User; setUser: (value: User | null) => void; notify: Notify; location: BrowserLocation; navigate: Navigate }) {
  const { t } = useI18n();
  const parsed = parseRoute(location.pathname, location.search);
  // Administration is administrator-only; others get the Monitor (and its URL) instead.
  const route = parsed.name === "admin" && !user.isAdmin ? parseRoute("/", "") : parsed;
  const monitorVisible = route.name === "monitor";
  const { status, intervalMinutes, checking, trackCheck } = useSchedulerStatus(location.pathname);
  // The last Monitor view is kept while other pages are open, so Monitor returns to it.
  const [lastMonitorView, setLastMonitorView] = useState<MonitorView | null>(null);
  const storedId = storedCollectionId(user.id);
  const remembered = lastMonitorView ?? { ...DEFAULT_MONITOR_VIEW, collectionId: storedId };
  const data = useWorkspaceData(notify, user.paginationEnabled, user.pageSize, monitorVisible, {
    view: route.name === "monitor" && route.explicit ? route.view : remembered,
    preferredCollectionIds: [lastMonitorView?.collectionId, storedId],
    onViewChange: (view, options) => { if (monitorVisible) navigate(monitorPath(view), options); else setLastMonitorView(view); },
  });
  const resolvedPath = data.collectionsLoaded ? monitorPath(data.view) : null;
  // "/" and unknown or deleted collections resolve to a collection without adding a history entry.
  useLayoutEffect(() => { if (monitorVisible && resolvedPath) navigate(resolvedPath, { replace: true }); }, [monitorVisible, resolvedPath, navigate]);
  // "/admin", unknown sections and invalid or default query values resolve to the canonical address in place.
  const adminCanonical = route.name === "admin" ? adminPath(route.tab, route.diagnostics) : null;
  useLayoutEffect(() => { if (adminCanonical && adminCanonical !== location.pathname + location.search) navigate(adminCanonical, { replace: true }); }, [adminCanonical, location.pathname, location.search, navigate]);
  useEffect(() => {
    if (!monitorVisible || !resolvedPath || !data.view.collectionId) return;
    setLastMonitorView(data.view); storeCollectionId(user.id, data.view.collectionId);
  }, [monitorVisible, resolvedPath, user.id]); // data.view is rebuilt every render; resolvedPath identifies it.
  const [newCollection, setNewCollection] = useState(false), [accountFocusRequest, setAccountFocusRequest] = useState(0);
  const collectionHref = (id: string) => monitorPath({ ...data.view, collectionId: id, page: 1 });
  const collectionNavigation = {
    collections: data.collections,
    selectedId: monitorVisible ? data.selectedId : null,
    hrefFor: collectionHref,
    onSelect: (id: string) => navigate(collectionHref(id)),
    onCreate: () => setNewCollection(true),
  };
  // Same unit as the Activity unread view: unread changes plus standalone "Mark unread" reminders.
  const unreadTotal = data.collections.reduce((sum, collection) => sum + collection.activityCount, 0);
  const loadCollections = useCallback(() => data.loadCollections().catch((error) => notify(errorMessage(error), "bad")), [data.loadCollections, notify]);
  async function logout() { try { await api("/api/auth/logout", { method: "POST" }); setUser(null); } catch (error) { notify(errorMessage(error), "bad"); } }
  const signOut: MenuItem = { id: "sign-out", label: t("Sign out"), icon: "logout", onSelect: () => void logout() };
  const changePassword: MenuItem = { id: "change-password", label: t("Change password"), icon: "key", onSelect: () => { navigate("/settings"); setAccountFocusRequest((value) => value + 1); } };
  const versionTitle = APP_REVISION ? `Torrentinel v${APP_VERSION} · build ${APP_REVISION.slice(0, 7)}` : `Torrentinel v${APP_VERSION}`;
  const accountSummary = <div className="account-summary"><span className="avatar" aria-hidden="true">{user.username.slice(0, 1).toUpperCase()}</span><span><strong>{user.username}</strong><small>{t(user.isAdmin ? "Administrator" : "Member")}</small></span></div>;
  const schedulerLine = (className: string) => <div className={className}><span className={`status-dot ${status?.running ? "status-dot--live" : ""}`} /><div><strong>{t(status?.running ? "Polling trackers" : "Monitor ready")}</strong><span>{status?.nextRunAt ? t("Next {time}", { time: relativeTime(status.nextRunAt) }) : intervalMinutes ? pollingCadence(intervalMinutes) : t("Loading schedule")}</span></div></div>;
  const page = route.name === "settings" ? <Settings user={user} onUserChange={setUser} notify={notify} accountFocusRequest={accountFocusRequest} onAccountFocused={() => setAccountFocusRequest(0)} />
    : route.name === "admin" ? <Admin notify={notify} tab={route.tab} diagnostics={route.diagnostics} pageSize={user.pageSize} navigate={navigate} />
    : route.name === "activity" ? <Activity key={route.filter} user={user} notify={notify} filter={route.filter} onFilterChange={(filter) => navigate(activityPath(filter))} collections={data.collections} onCollectionsChanged={loadCollections} />
    : <Workspace user={user} onUserChange={setUser} notify={notify} data={data} onNewCollection={() => setNewCollection(true)} />;
  return <div className="app-shell">
    <aside className="app-nav">
      <div className="brand-lockup"><BrandMark size={28} scanning={checking} /><strong>Torrentinel</strong></div>
      <nav><NavItem to={lastMonitorView ? monitorPath(lastMonitorView) : "/"} icon="monitor" label={t("Monitor")} active={monitorVisible} navigate={navigate} />
        <NavItem to="/activity" icon="activity" label={t("Activity")} active={route.name === "activity"} navigate={navigate} badge={unreadTotal} /></nav>
      <CollectionsNavigation {...collectionNavigation} className="collection-navigation--desktop" />
      <nav className="secondary-nav"><NavItem to="/settings" icon="sliders" label={t("Settings")} active={route.name === "settings"} navigate={navigate} />{user.isAdmin && <NavItem to="/admin" icon="users" label={t("Administration")} active={route.name === "admin"} navigate={navigate} />}</nav>
      <MenuButton className="nav-link account-nav" triggerLabel={t("Account")} menuLabel={t("Account")} offset={16} header={<>{accountSummary}{schedulerLine("scheduler-mini scheduler-mini--menu")}</>}
        items={[changePassword, signOut, { id: "version", label: `Torrentinel v${APP_VERSION}`, icon: "external", href: RELEASE_URL, title: versionTitle }]}><Icon name="user" size={18} /><span>{t("Account")}</span></MenuButton>
      {schedulerLine("scheduler-mini")}
      <MenuButton className="account-button" menuLabel={t("Account")} align="start" items={[changePassword, signOut]}><span className="avatar" aria-hidden="true">{user.username.slice(0, 1).toUpperCase()}</span><span><strong>{user.username}</strong><small>{t(user.isAdmin ? "Administrator" : "Member")}</small></span><Icon name="more" size={16} /></MenuButton>
      <a className="app-version" href={RELEASE_URL} target="_blank" rel="noreferrer" title={versionTitle}>v{APP_VERSION}</a>
    </aside>
    <div className="app-stage">
      {monitorVisible ? <CollectionsNavigation {...collectionNavigation} className="collection-navigation--mobile" /> : <CollectionSwitcher key={location.pathname} {...collectionNavigation} current={data.collections.find((collection) => collection.id === data.selectedId)} />}
      <CheckActivityContext.Provider value={trackCheck}>{page}</CheckActivityContext.Provider>
    </div>
    {newCollection && <NewCollection onClose={() => setNewCollection(false)} onCreated={async (id) => { await data.loadCollections(); setNewCollection(false); navigate(monitorPath({ ...DEFAULT_MONITOR_VIEW, collectionId: id })); }} notify={notify} />}
  </div>;
}
// Mobile-only compact entry point to the collections strip outside Monitor.
function CollectionSwitcher({ current, ...navigation }: Omit<Parameters<typeof CollectionsNavigation>[0], "className" | "id"> & { current?: Collection }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false), listId = useId();
  return <div className="collection-switcher">
    <div className="collection-switcher__bar">
      <button type="button" className="collection-switcher__toggle" aria-expanded={expanded} aria-controls={expanded ? listId : undefined} onClick={() => setExpanded((value) => !value)}>
        <span className="collection-switcher__label">{t("Collections")}</span><span className="collection-switcher__separator" aria-hidden="true">·</span><span className="collection-switcher__current">{current?.name ?? t("No collection selected")}</span><Icon name="chevron" size={17} />
      </button>
      <button type="button" className="icon-button" aria-label={t("New collection")} title={t("New collection")} onClick={navigation.onCreate}><Icon name="plus" /></button>
    </div>
    {expanded && <CollectionsNavigation {...navigation} id={listId} className="collection-navigation--mobile collection-navigation--switcher" />}
  </div>;
}
function NavItem({ to, icon, label, active, navigate, badge = 0 }: { to: string; icon: IconName; label: string; active: boolean; navigate: Navigate; badge?: number }) {
  const { t } = useI18n();
  return <a href={to} aria-label={badge ? `${label}, ${t("{count} unread", { count: badge })}` : label} aria-current={active ? "page" : undefined} className={active ? "nav-link nav-link--active" : "nav-link"} onClick={(event) => { if (!isPlainClick(event)) return; event.preventDefault(); navigate(to); }}>
    <Icon name={icon} size={18} /><span>{label}</span>{badge > 0 && <span className="count-badge nav-badge" aria-hidden="true">{badge > 99 ? "99+" : badge}</span>}
  </a>;
}
function useBrowserLocation(): [BrowserLocation, Navigate] {
  const read = () => ({ pathname: window.location.pathname, search: window.location.search });
  const [location, setLocation] = useState<BrowserLocation>(read);
  useEffect(() => { const handlePopState = () => setLocation(read()); window.addEventListener("popstate", handlePopState); return () => window.removeEventListener("popstate", handlePopState); }, []);
  const navigate = useCallback<Navigate>((path, options) => {
    if (path === window.location.pathname + window.location.search) return;
    window.history[options?.replace ? "replaceState" : "pushState"]({}, "", path);
    setLocation(read());
  }, []);
  return [location, navigate];
}
