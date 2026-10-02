import { useCallback, useEffect, useState } from "react";
import packageManifest from "../package.json";
import { api, ApiError } from "./api";
import { useSchedulerStatus } from "./hooks/useSchedulerStatus";
import { useWorkspaceData } from "./hooks/useWorkspaceData";
import { CollectionsNavigation, NewCollection } from "./components/CollectionsNavigation";
import { DialogProvider } from "./components/Dialogs";
import { CheckActivityContext, TrackerMarkerStyleContext } from "./components/contexts";
import { Icon, type IconName } from "./components/Icon";
import { BrandMark } from "./components/UI";
import { Admin } from "./pages/Administration";
import { BootScreen, ChangePassword, Login } from "./pages/Authentication";
import { Settings } from "./pages/Settings";
import { Workspace } from "./pages/Workspace";
import { errorMessage, pollingCadence, relativeTime } from "./format";
import { setLanguage, useI18n } from "./i18n";
import { applyTheme } from "./theme";
import type { Notify, User } from "./types";

type Toast = { id: number; message: string; tone: "good" | "bad" };
const APP_VERSION = packageManifest.version;
const APP_REVISION = import.meta.env.VITE_APP_REVISION?.trim();
const RELEASE_URL = `https://github.com/ib0ndar/Torrentinel/releases/tag/v${APP_VERSION}`;

export default function App() {
  const [user, setUser] = useState<User | null | undefined>(undefined), [toast, setToast] = useState<Toast | null>(null);
  const [path, navigate] = useSimpleRouter();
  const notify = useCallback((message: string, tone: Toast["tone"] = "good") => setToast({ id: Date.now(), message, tone }), []);
  const updateUser = useCallback((value: User | null) => { if (value) { setLanguage(value.language); applyTheme(value.theme); } setUser(value); }, []);
  useEffect(() => {
    api<{ user: User }>("/api/auth/me").then(({ user: current }) => updateUser(current)).catch((error) => {
      if (error instanceof ApiError && error.status === 401) setUser(null); else notify(errorMessage(error), "bad");
    });
  }, [notify, updateUser]);
  useEffect(() => { if (!toast) return; const timer = window.setTimeout(() => setToast(null), 4_000); return () => window.clearTimeout(timer); }, [toast]);
  if (user === undefined) return <BootScreen />;
  if (!user) return <><Login onLogin={updateUser} notify={notify} />{toast && <div key={toast.id} className={`toast toast--${toast.tone}`}>{toast.message}</div>}</>;
  if (user.mustChangePassword) return <><ChangePassword user={user} onChanged={updateUser} notify={notify} />{toast && <div key={toast.id} className={`toast toast--${toast.tone}`}>{toast.message}</div>}</>;
  return <TrackerMarkerStyleContext.Provider value={user.trackerMarkerStyle}><DialogProvider><AppShell key={user.id} user={user} setUser={updateUser} notify={notify} path={path} navigate={navigate} />
    {toast && <div key={toast.id} className={`toast toast--${toast.tone}`}>{toast.message}</div>}
  </DialogProvider></TrackerMarkerStyleContext.Provider>;
}
function AppShell({ user, setUser, notify, path, navigate }: { user: User; setUser: (value: User | null) => void; notify: Notify; path: string; navigate: (path: string) => void }) {
  const { t } = useI18n();
  const { status, intervalMinutes, checking, trackCheck } = useSchedulerStatus(path);
  const monitorVisible = path !== "/settings" && !(path === "/admin" && user.isAdmin);
  const data = useWorkspaceData(notify, user.paginationEnabled, user.pageSize, monitorVisible);
  const [newCollection, setNewCollection] = useState(false);
  const collectionNavigation = {
    collections: data.collections,
    selectedId: monitorVisible ? data.selectedId : null,
    onSelect: (id: string) => { data.setSelectedId(id); navigate("/"); },
    onCreate: () => setNewCollection(true),
  };
  async function logout() { try { await api("/api/auth/logout", { method: "POST" }); setUser(null); } catch (error) { notify(errorMessage(error), "bad"); } }
  return <div className="app-shell">
    <aside className="app-nav">
      <div className="brand-lockup"><BrandMark size={28} scanning={checking} /><strong>Torrentinel</strong></div>
      <nav><NavItem to="/" icon="monitor" label={t("Monitor")} active={monitorVisible} navigate={navigate} /></nav>
      <CollectionsNavigation {...collectionNavigation} className="collection-navigation--desktop" />
      <nav className="secondary-nav"><NavItem to="/settings" icon="sliders" label={t("Settings")} active={path === "/settings"} navigate={navigate} />{user.isAdmin && <NavItem to="/admin" icon="users" label={t("Administration")} active={path === "/admin"} navigate={navigate} />}</nav>
      <div className="scheduler-mini"><span className={`status-dot ${status?.running ? "status-dot--live" : ""}`} /><div><strong>{t(status?.running ? "Polling trackers" : "Monitor ready")}</strong><span>{status?.nextRunAt ? t("Next {time}", { time: relativeTime(status.nextRunAt) }) : intervalMinutes ? pollingCadence(intervalMinutes) : t("Loading schedule")}</span></div></div>
      <button className="account-button" onClick={logout}><span className="avatar">{user.username.slice(0, 1).toUpperCase()}</span><span><strong>{user.username}</strong><small>{t("Sign out")}</small></span><Icon name="arrow" size={15} /></button>
      <a className="app-version" href={RELEASE_URL} target="_blank" rel="noreferrer" title={APP_REVISION ? `Torrentinel v${APP_VERSION} · build ${APP_REVISION.slice(0, 7)}` : `Torrentinel v${APP_VERSION}`}>v{APP_VERSION}</a>
    </aside>
    <div className="app-stage">
      <CollectionsNavigation {...collectionNavigation} className="collection-navigation--mobile" />
      <CheckActivityContext.Provider value={trackCheck}>{path === "/settings" ? <Settings user={user} onUserChange={setUser} notify={notify} /> : path === "/admin" && user.isAdmin ? <Admin notify={notify} /> : <Workspace user={user} onUserChange={setUser} notify={notify} data={data} onNewCollection={() => setNewCollection(true)} />}</CheckActivityContext.Provider>
    </div>
    {newCollection && <NewCollection onClose={() => setNewCollection(false)} onCreated={async (id) => { await data.loadCollections(); data.setSelectedId(id); setNewCollection(false); navigate("/"); }} notify={notify} />}
  </div>;
}
function NavItem({ to, icon, label, active, navigate }: { to: string; icon: IconName; label: string; active: boolean; navigate: (path: string) => void }) {
  return <a href={to} aria-label={label} aria-current={active ? "page" : undefined} className={active ? "nav-link nav-link--active" : "nav-link"} onClick={(event) => { if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); navigate(to); }}><Icon name={icon} size={18} /><span>{label}</span></a>;
}
function useSimpleRouter(): [string, (path: string) => void] {
  const currentPath = () => ["/", "/settings", "/admin"].includes(window.location.pathname) ? window.location.pathname : "/";
  const [path, setPath] = useState(currentPath);
  useEffect(() => { const handlePopState = () => setPath(currentPath()); window.addEventListener("popstate", handlePopState); return () => window.removeEventListener("popstate", handlePopState); }, []);
  const navigate = useCallback((nextPath: string) => { if (nextPath === path) return; window.history.pushState({}, "", nextPath); setPath(nextPath); }, [path]);
  return [path, navigate];
}
