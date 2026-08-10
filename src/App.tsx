import {
  type CSSProperties,
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import packageManifest from "../package.json";
import { api, ApiError, jsonBody } from "./api";
import type {
  AdminMirror,
  AdminUser,
  Collection,
  DiagnosticsResponse,
  RuleMatch,
  SchedulerStatus,
  Subscription,
  SubscriptionEvent,
  TelegramStatus,
  Tracker,
  TrackerKey,
  User,
} from "./types";

type Toast = { id: number; message: string; tone: "good" | "bad" };

const APP_VERSION = packageManifest.version;
const APP_REVISION = import.meta.env.VITE_APP_REVISION?.trim();
const RELEASE_URL = `https://github.com/ib0ndar/Torrentinel/releases/tag/v${APP_VERSION}`;

const DEFAULT_IGNORED_PHRASES = [
  "Trailer",
  "Трейлер",
  "Teaser",
  "Тизер",
  "Soundtrack",
  "Саундтрек",
];

const POLL_INTERVAL_OPTIONS = [
  5, 10, 15, 20, 30, 45,
  60, 90, 120, 180, 240, 300, 360,
] as const;

const POLL_INTERVAL_MARKERS = [5, 60, 180, 360] as const;

export default function App() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [toast, setToast] = useState<Toast | null>(null);
  const [path, navigate] = useSimpleRouter();

  const notify = useCallback((message: string, tone: Toast["tone"] = "good") => {
    setToast({ id: Date.now(), message, tone });
  }, []);

  useEffect(() => {
    api<{ user: User }>("/api/auth/me")
      .then(({ user: current }) => setUser(current))
      .catch((error) => {
        if (error instanceof ApiError && error.status === 401) setUser(null);
        else notify(errorMessage(error), "bad");
      });
  }, [notify]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 4_000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  if (user === undefined) return <BootScreen />;
  if (!user) return <Login onLogin={setUser} notify={notify} />;
  if (user.mustChangePassword) return <ChangePassword user={user} onChanged={setUser} notify={notify} />;

  return (
    <>
      <AppShell
        user={user}
        setUser={setUser}
        notify={notify}
        path={path}
        navigate={navigate}
        renderPage={(intervalMinutes) => path === "/settings"
          ? <Settings notify={notify} />
          : path === "/admin" && user.isAdmin
            ? <Admin notify={notify} />
            : <Workspace notify={notify} intervalMinutes={intervalMinutes} />}
      />
      {toast && <div key={toast.id} className={`toast toast--${toast.tone}`}>{toast.message}</div>}
    </>
  );
}

function BootScreen() {
  return (
    <div className="boot-screen">
      <BrandMark size={42} />
      <span>Starting Torrentinel</span>
      <span className="loading-line" />
    </div>
  );
}

function Login({ onLogin, notify }: { onLogin: (user: User) => void; notify: Notify }) {
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("admin");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await api<{ user: User }>("/api/auth/login", {
        method: "POST",
        ...jsonBody({ username, password }),
      });
      onLogin(result.user);
    } catch (error) {
      notify(errorMessage(error), "bad");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login-page">
      <section className="login-brand">
        <BrandMark size={54} />
        <div>
          <p className="eyebrow">Private release monitor</p>
          <h1>Torrentinel</h1>
          <p>Track change. Catch the release.</p>
        </div>
      </section>
      <form className="login-form" onSubmit={submit}>
        <p className="eyebrow">Local access</p>
        <h2>Sign in</h2>
        <Field label="Username">
          <input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" autoFocus />
        </Field>
        <Field label="Password">
          <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" />
        </Field>
        <button className="button button--primary button--wide" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </main>
  );
}

function ChangePassword({ user, onChanged, notify }: { user: User; onChanged: (user: User) => void; notify: Notify }) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (newPassword !== confirm) return notify("New passwords do not match", "bad");
    setBusy(true);
    try {
      const result = await api<{ user: User }>("/api/auth/change-password", {
        method: "POST",
        ...jsonBody({ currentPassword, newPassword }),
      });
      onChanged(result.user);
      notify("Password changed");
    } catch (error) {
      notify(errorMessage(error), "bad");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="password-page">
      <section className="password-panel">
        <BrandMark size={40} />
        <p className="eyebrow">First sign-in</p>
        <h1>Secure the admin account.</h1>
        <p>The default password cannot be used after setup.</p>
        <form onSubmit={submit}>
          <Field label="Current password"><input type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} autoFocus /></Field>
          <Field label="New password"><input type="password" minLength={8} value={newPassword} onChange={(e) => setNewPassword(e.target.value)} /></Field>
          <Field label="Confirm new password"><input type="password" minLength={8} value={confirm} onChange={(e) => setConfirm(e.target.value)} /></Field>
          <button className="button button--primary button--wide" disabled={busy}>Save new password</button>
        </form>
      </section>
    </main>
  );
}

function AppShell({ user, setUser, notify, path, navigate, renderPage }: { user: User; setUser: (value: User | null) => void; notify: Notify; path: string; navigate: (path: string) => void; renderPage: (intervalMinutes: number | null) => ReactNode }) {
  const [status, setStatus] = useState<SchedulerStatus | null>(null);
  const [intervalMinutes, setIntervalMinutes] = useState<number | null>(null);

  const loadStatus = useCallback(() => {
    api<{ scheduler: SchedulerStatus; intervalMinutes: number }>("/api/system/status")
      .then((result) => {
        setStatus(result.scheduler);
        setIntervalMinutes(result.intervalMinutes);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    loadStatus();
    const interval = window.setInterval(loadStatus, 30_000);
    return () => window.clearInterval(interval);
  }, [loadStatus, path]);

  async function logout() {
    try {
      await api("/api/auth/logout", { method: "POST" });
      setUser(null);
    } catch (error) {
      notify(errorMessage(error), "bad");
    }
  }

  return (
    <div className="app-shell">
      <aside className="app-nav">
        <div className="brand-lockup"><BrandMark size={28} /><strong>Torrentinel</strong></div>
        <nav>
          <NavItem to="/" icon="monitor" label="Monitor" active={path === "/"} navigate={navigate} />
          <NavItem to="/settings" icon="sliders" label="Settings" active={path === "/settings"} navigate={navigate} />
          {user.isAdmin && <NavItem to="/admin" icon="users" label="Administration" active={path === "/admin"} navigate={navigate} />}
        </nav>
        <div className="nav-spacer" />
        <div className="scheduler-mini">
          <span className={`status-dot ${status?.running ? "status-dot--live" : ""}`} />
          <div>
            <strong>{status?.running ? "Polling trackers" : "Monitor ready"}</strong>
            <span>{status?.nextRunAt ? `Next ${relativeTime(status.nextRunAt)}` : intervalMinutes ? pollingCadence(intervalMinutes) : "Loading schedule"}</span>
          </div>
        </div>
        <button className="account-button" onClick={logout}>
          <span className="avatar">{user.username.slice(0, 1).toUpperCase()}</span>
          <span><strong>{user.username}</strong><small>Sign out</small></span>
          <Icon name="arrow" size={15} />
        </button>
        <a
          className="app-version"
          href={RELEASE_URL}
          target="_blank"
          rel="noreferrer"
          title={APP_REVISION ? `Torrentinel v${APP_VERSION} · build ${APP_REVISION.slice(0, 7)}` : `Torrentinel v${APP_VERSION}`}
        >
          v{APP_VERSION}
        </a>
      </aside>
      <div className="app-stage">{renderPage(intervalMinutes)}</div>
    </div>
  );
}

function NavItem({ to, icon, label, active, navigate }: { to: string; icon: IconName; label: string; active: boolean; navigate: (path: string) => void }) {
  return <a href={to} onClick={(event) => { event.preventDefault(); navigate(to); }} className={active ? "nav-link nav-link--active" : "nav-link"}><Icon name={icon} size={18} /><span>{label}</span></a>;
}

function Workspace({ notify, intervalMinutes }: { notify: Notify; intervalMinutes: number | null }) {
  const [collections, setCollections] = useState<Collection[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"all" | "unread" | "updated" | "errors">("all");
  const [search, setSearch] = useState("");
  const [newCollection, setNewCollection] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedSubscription, setSelectedSubscription] = useState<string | null>(null);

  const loadCollections = useCallback(async () => {
    const result = await api<{ collections: Collection[] }>("/api/collections");
    setCollections(result.collections);
    setSelectedId((current) => current && result.collections.some((item) => item.id === current) ? current : result.collections[0]?.id || null);
  }, []);

  const loadSubscriptions = useCallback(async () => {
    if (!selectedId) {
      setSubscriptions([]);
      setLoading(false);
      return;
    }
    try {
      const result = await api<{ subscriptions: Subscription[] }>(`/api/subscriptions?collectionId=${encodeURIComponent(selectedId)}`);
      setSubscriptions(result.subscriptions);
    } finally {
      setLoading(false);
    }
  }, [selectedId]);

  const refresh = useCallback(async () => {
    try {
      await Promise.all([loadCollections(), loadSubscriptions()]);
    } catch (error) {
      notify(errorMessage(error), "bad");
    }
  }, [loadCollections, loadSubscriptions, notify]);

  useEffect(() => { void loadCollections().catch((error) => notify(errorMessage(error), "bad")); }, [loadCollections, notify]);
  useEffect(() => { void loadSubscriptions().catch((error) => notify(errorMessage(error), "bad")); }, [loadSubscriptions, notify]);
  useEffect(() => {
    const interval = window.setInterval(() => void refresh(), 30_000);
    return () => window.clearInterval(interval);
  }, [refresh]);

  const selected = collections.find((collection) => collection.id === selectedId);
  const visible = useMemo(() => subscriptions.filter((item) => {
    if (filter === "unread" && !item.isUnread) return false;
    if (filter === "updated" && !item.isUpdated) return false;
    if (filter === "errors" && !item.lastError) return false;
    return !search || `${item.label} ${item.requiredTerms.join(" ")} ${item.trackerKeys.join(" ")}`.toLowerCase().includes(search.toLowerCase());
  }), [subscriptions, filter, search]);

  async function renameCollection() {
    if (!selected) return;
    const name = window.prompt("Collection name", selected.name)?.trim();
    if (!name || name === selected.name) return;
    try {
      await api(`/api/collections/${selected.id}`, { method: "PATCH", ...jsonBody({ name }) });
      await loadCollections();
      notify("Collection renamed");
    } catch (error) { notify(errorMessage(error), "bad"); }
  }

  async function deleteCollection() {
    if (!selected || !window.confirm(`Delete “${selected.name}” and all of its subscriptions?`)) return;
    try {
      await api(`/api/collections/${selected.id}`, { method: "DELETE" });
      setSelectedId(null);
      await loadCollections();
      notify("Collection deleted");
    } catch (error) { notify(errorMessage(error), "bad"); }
  }

  return (
    <div className="workspace">
      <aside className="collection-rail">
        <div className="rail-heading"><span>Collections</span><button className="icon-button" title="New collection" onClick={() => setNewCollection(true)}><Icon name="plus" /></button></div>
        <div className="collection-list">
          {collections.map((collection) => (
            <button key={collection.id} className={`collection-item ${selectedId === collection.id ? "collection-item--active" : ""}`} onClick={() => setSelectedId(collection.id)}>
              <span className="collection-glyph">{collection.name.slice(0, 1).toUpperCase()}</span>
              <span className="collection-copy"><strong>{collection.name}</strong><small>{collection.subscriptionCount} subscriptions</small></span>
              {(collection.unreadCount > 0 || collection.updatedCount > 0) && <span className="count-badge">{collection.unreadCount || collection.updatedCount}</span>}
            </button>
          ))}
        </div>
        {collections.length === 0 && <EmptyCompact text="Create a collection to start monitoring." />}
        <div className="rail-footer"><Icon name="clock" size={15} /><span>{intervalMinutes ? `Checks run every ${formatPollInterval(intervalMinutes)}` : "Loading check interval"}</span></div>
      </aside>

      <section className="subscription-pane">
        {selected ? (
          <>
            <header className="pane-header">
              <div><p className="eyebrow">Collection</p><h1>{selected.name}</h1></div>
              <div className="header-actions">
                <button className="icon-button" title="Rename collection" onClick={renameCollection}><Icon name="edit" /></button>
                <button className="icon-button icon-button--danger" title="Delete collection" onClick={deleteCollection}><Icon name="trash" /></button>
                <button className="button button--primary" onClick={() => setCreateOpen(true)}><Icon name="plus" size={16} />Add subscription</button>
              </div>
            </header>

            <div className="list-toolbar">
              <div className="filter-tabs">
                {(["all", "unread", "updated", "errors"] as const).map((name) => <button key={name} className={filter === name ? "active" : ""} onClick={() => setFilter(name)}>{capitalize(name)}</button>)}
              </div>
              <label className="search-box"><Icon name="search" size={16} /><input placeholder="Filter this collection" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
            </div>

            <div className="subscription-head"><span>Subscription</span><span>Source</span><span>Last check</span><span>Status</span></div>
            <div className="subscription-list">
              {loading ? <ListSkeleton /> : visible.map((item, index) => (
                <SubscriptionRow key={item.id} item={item} index={index} onOpen={() => setSelectedSubscription(item.id)} onChanged={refresh} notify={notify} />
              ))}
              {!loading && visible.length === 0 && <EmptyState icon="monitor" title={subscriptions.length ? "Nothing matches this view" : "No subscriptions yet"} text={subscriptions.length ? "Try a different status filter or search." : "Add a direct tracker link or a rule to begin monitoring."} action={!subscriptions.length ? <button className="button button--primary" onClick={() => setCreateOpen(true)}>Add subscription</button> : undefined} />}
            </div>
          </>
        ) : <EmptyState icon="folder" title="Create your first collection" text="Collections keep each user’s subscriptions separate and organized." action={<button className="button button--primary" onClick={() => setNewCollection(true)}>New collection</button>} />}
      </section>

      {newCollection && <NewCollection onClose={() => setNewCollection(false)} onCreated={async (id) => { setNewCollection(false); await loadCollections(); setSelectedId(id); }} notify={notify} />}
      {createOpen && selected && <CreateSubscription collection={selected} onClose={() => setCreateOpen(false)} onCreated={async () => { setCreateOpen(false); await refresh(); }} notify={notify} />}
      {selectedSubscription && <SubscriptionInspector id={selectedSubscription} collections={collections} onClose={() => setSelectedSubscription(null)} onChanged={refresh} notify={notify} />}
    </div>
  );
}

function SubscriptionRow({ item, index, onOpen, onChanged, notify }: { item: Subscription; index: number; onOpen: () => void; onChanged: () => Promise<void>; notify: Notify }) {
  async function markRead(event: ReactMouseEvent) {
    event.stopPropagation();
    try {
      await api(`/api/subscriptions/${item.id}/read`, { method: "POST", ...jsonBody({ read: item.isUnread }) });
      await onChanged();
    } catch (error) { notify(errorMessage(error), "bad"); }
  }

  return (
    <div className={`subscription-row ${item.isUnread ? "subscription-row--unread" : ""} ${item.isUpdated ? "subscription-row--updated" : ""}`} style={{ "--row-index": index } as CSSProperties}>
      <button type="button" className="subscription-open" onClick={onOpen}>
        <span className="subscription-main">
          <span className={`type-icon type-icon--${item.type} ${item.isUpdated ? "type-icon--updated" : ""}`}><Icon name={item.isUpdated ? "bellAlert" : item.type === "direct" ? "link" : "rule"} size={17} /></span>
          <span>
            {item.type === "rule" ? <PhraseDisplay phrases={item.requiredTerms} /> : <strong>{item.label}</strong>}
            <small>{item.type === "rule" ? item.ignoredTerms.length ? `Excludes ${item.ignoredTerms.join(", ")}` : "Matches every required phrase" : item.directUrl}</small>
          </span>
          {item.isUpdated && <span className="updated-marker" title="Updated" />}
        </span>
        <span className="tracker-stack">{item.trackerKeys.map((key) => <TrackerTag key={key} tracker={key} />)}</span>
        <span className="time-cell">{item.lastCheckedAt ? relativeTime(item.lastCheckedAt) : "Pending"}</span>
        <span className="row-status">{item.lastError ? <span className="state state--error">Needs attention</span> : !item.enabled ? <span className="state">Paused</span> : item.isUpdated ? <span className="state state--updated">Updated</span> : !item.initialized ? <span className="state state--pending">Learning</span> : <span className="state state--good">Watching</span>}</span>
      </button>
      <button
        type="button"
        className={`read-toggle ${item.isUnread ? "read-toggle--unread" : ""}`}
        aria-label={item.isUnread ? "Unread. Mark read" : "Read. Mark unread"}
        title={item.isUnread ? "Unread — click to mark read" : "Read — click to mark unread"}
        onClick={markRead}
      >
        <Icon name={item.isUnread ? "unread" : "check"} size={18} />
      </button>
    </div>
  );
}

function NewCollection({ onClose, onCreated, notify }: { onClose: () => void; onCreated: (id: string) => Promise<void>; notify: Notify }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true);
    try {
      const result = await api<{ collection: Collection }>("/api/collections", { method: "POST", ...jsonBody({ name }) });
      await onCreated(result.collection.id); notify("Collection created");
    } catch (error) { notify(errorMessage(error), "bad"); } finally { setBusy(false); }
  }
  return <Drawer title="New collection" subtitle="Create an isolated place for related subscriptions." onClose={onClose}><form onSubmit={submit}><Field label="Collection name"><input value={name} onChange={(event) => setName(event.target.value)} maxLength={80} autoFocus /></Field><DrawerActions onCancel={onClose} busy={busy} label="Create collection" /></form></Drawer>;
}

function CreateSubscription({ collection, onClose, onCreated, notify }: { collection: Collection; onClose: () => void; onCreated: () => Promise<void>; notify: Notify }) {
  const [type, setType] = useState<"direct" | "rule">("direct");
  const [url, setUrl] = useState("");
  const [required, setRequired] = useState<string[]>([]);
  const [ignored, setIgnored] = useState<string[]>([...DEFAULT_IGNORED_PHRASES]);
  const [selectedTrackers, setSelectedTrackers] = useState<TrackerKey[]>(["kinozal", "rutor", "rutracker"]);
  const [trackers, setTrackers] = useState<Tracker[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => { api<{ trackers: Tracker[] }>("/api/trackers").then((result) => setTrackers(result.trackers)).catch((error) => notify(errorMessage(error), "bad")); }, [notify]);

  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true);
    const payload = type === "direct"
      ? { type, collectionId: collection.id, url }
      : { type, collectionId: collection.id, trackerKeys: selectedTrackers, requiredTerms: required, ignoredTerms: ignored };
    try {
      await api("/api/subscriptions", { method: "POST", ...jsonBody(payload) });
      await onCreated(); notify(type === "direct" ? "Direct subscription added" : "Rule added and baseline scan started");
    } catch (error) { notify(errorMessage(error), "bad"); } finally { setBusy(false); }
  }

  return (
    <Drawer title="Add subscription" subtitle={`New monitor in ${collection.name}`} onClose={onClose} wide>
      <div className="segmented"><button className={type === "direct" ? "active" : ""} onClick={() => setType("direct")} type="button"><Icon name="link" />Direct link</button><button className={type === "rule" ? "active" : ""} onClick={() => setType("rule")} type="button"><Icon name="rule" />Rule</button></div>
      <form onSubmit={submit}>
        {type === "direct" ? <>
          <Field label="Tracker page URL" hint="Kinozal, Rutor, or RuTracker"><input type="url" placeholder="https://…" value={url} onChange={(event) => setUrl(event.target.value)} autoFocus required /></Field>
          <InfoLine icon="clock">The initial check creates a baseline. Later title, magnet, torrent-file, and metadata changes create events.</InfoLine>
        </> : <>
          <Field label="Trackers"><div className="tracker-picker">{trackers.map((tracker) => <label key={tracker.key} className={selectedTrackers.includes(tracker.key) ? "tracker-choice tracker-choice--active" : "tracker-choice"}><input type="checkbox" checked={selectedTrackers.includes(tracker.key)} onChange={() => setSelectedTrackers((current) => current.includes(tracker.key) ? current.filter((key) => key !== tracker.key) : [...current, tracker.key])} /><TrackerTag tracker={tracker.key} /><span>{tracker.displayName}</span>{!tracker.credentialsConfigured && tracker.key !== "rutor" && <small>credentials missing</small>}</label>)}</div></Field>
          <Field label="Required phrases" hint="Press Enter after each phrase. Every phrase must appear."><PhraseInput ariaLabel="Required phrases" value={required} onChange={setRequired} placeholder="Type a phrase and press Enter" /></Field>
          <Field label="Ignored phrases" hint="Press Enter after each phrase. Any match is rejected."><PhraseInput ariaLabel="Ignored phrases" value={ignored} onChange={setIgnored} placeholder="Type a phrase and press Enter" /></Field>
          <InfoLine icon="monitor">The first successful poll is a silent baseline. Only releases discovered afterward produce events.</InfoLine>
        </>}
        <DrawerActions onCancel={onClose} busy={busy} label={type === "direct" ? "Add direct link" : "Create rule"} disabled={type === "rule" && (!selectedTrackers.length || !required.length)} />
      </form>
    </Drawer>
  );
}

function SubscriptionInspector({ id, collections, onClose, onChanged, notify }: { id: string; collections: Collection[]; onClose: () => void; onChanged: () => Promise<void>; notify: Notify }) {
  const [item, setItem] = useState<Subscription | null>(null);
  const [events, setEvents] = useState<SubscriptionEvent[]>([]);
  const [matches, setMatches] = useState<RuleMatch[]>([]);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);

  const load = useCallback(async () => {
    const result = await api<{ subscription: Subscription; events: SubscriptionEvent[]; matches: RuleMatch[] }>(`/api/subscriptions/${id}`);
    setItem(result.subscription); setEvents(result.events); setMatches(result.matches);
  }, [id]);

  useEffect(() => {
    void load().catch((error) => notify(errorMessage(error), "bad"));
    void api(`/api/subscriptions/${id}/viewed`, { method: "POST" }).then(onChanged).catch(() => undefined);
  }, [id, load, notify, onChanged]);
  useEffect(() => {
    const interval = window.setInterval(() => void load().catch(() => undefined), 30_000);
    return () => window.clearInterval(interval);
  }, [load]);

  async function update(payload: Record<string, unknown>, message: string) {
    setBusy(true);
    try { await api(`/api/subscriptions/${id}`, { method: "PATCH", ...jsonBody(payload) }); await Promise.all([load(), onChanged()]); notify(message); return true; }
    catch (error) { notify(errorMessage(error), "bad"); return false; } finally { setBusy(false); }
  }

  async function checkNow() {
    setBusy(true);
    try { await api(`/api/subscriptions/${id}/check`, { method: "POST" }); await Promise.all([load(), onChanged()]); notify("Tracker check completed"); }
    catch (error) { notify(errorMessage(error), "bad"); } finally { setBusy(false); }
  }

  async function markRead() {
    if (!item) return;
    try { await api(`/api/subscriptions/${id}/read`, { method: "POST", ...jsonBody({ read: item.isUnread }) }); await Promise.all([load(), onChanged()]); }
    catch (error) { notify(errorMessage(error), "bad"); }
  }

  async function remove() {
    if (!item || !window.confirm(item.type === "rule" ? "Delete this rule?" : `Delete “${item.label}”?`)) return;
    try { await api(`/api/subscriptions/${id}`, { method: "DELETE" }); await onChanged(); onClose(); notify("Subscription deleted"); }
    catch (error) { notify(errorMessage(error), "bad"); }
  }

  return (
    <Drawer
      title={item?.label || "Subscription"}
      subtitle={item ? `${capitalize(item.type)} subscription` : "Loading details"}
      onClose={onClose}
      extraWide
      headerMedia={item?.type === "direct" && item.currentSnapshot?.coverUrl
        ? <ReleaseCover key={item.currentSnapshot.coverUrl} url={item.currentSnapshot.coverUrl} title={item.currentSnapshot.title || item.label} thumbnail />
        : undefined}
    >
      {!item ? <ListSkeleton /> : <div className="inspector">
        <div className="inspector-status"><span className={`status-dot ${item.enabled && !item.lastError ? "status-dot--live" : ""}`} /><div><strong>{item.lastError ? "Check failed" : item.enabled ? "Monitoring" : "Paused"}</strong><span>{item.lastCheckedAt ? `Last checked ${relativeTime(item.lastCheckedAt)}` : "Waiting for first check"}</span></div><button className="button button--quiet" disabled={busy} onClick={checkNow}><Icon name="refresh" />Check now</button></div>
        {item.lastError && <div className="error-strip"><Icon name="alert" />{item.lastError}</div>}

        <section className="detail-section"><div className="section-heading"><h3>Configuration</h3><button className="text-button" onClick={() => setEditing((value) => !value)}>{editing ? "Cancel" : "Edit"}</button></div>{editing ? <EditSubscriptionForm item={item} busy={busy} onCancel={() => setEditing(false)} onSave={async (payload) => { const saved = await update(payload, "Subscription configuration saved"); if (saved) setEditing(false); }} /> : <dl className="detail-grid"><div><dt>Collection</dt><dd><select value={item.collectionId} onChange={(event) => void update({ collectionId: event.target.value }, "Subscription moved")}>{collections.map((collection) => <option key={collection.id} value={collection.id}>{collection.name}</option>)}</select></dd></div><div><dt>Sources</dt><dd className="tracker-stack">{item.trackerKeys.map((key) => <TrackerTag key={key} tracker={key} />)}</dd></div>{item.type === "rule" && <><div><dt>Required</dt><dd>{item.requiredTerms.join(" · ")}</dd></div><div><dt>Ignored</dt><dd>{item.ignoredTerms.join(" · ") || "None"}</dd></div></>}<div><dt>State</dt><dd>{item.initialized ? "Baseline established" : "Learning baseline"}</dd></div></dl>}</section>

        {item.type === "direct" && <section className="detail-section"><div className="release-actions"><h3>Release</h3><div className="source-links"><a href={item.currentSnapshot?.url || item.directUrl || "#"} target="_blank" rel="noreferrer"><Icon name="external" />Tracker page</a>{item.currentSnapshot?.magnet && <a href={item.currentSnapshot.magnet}><Icon name="magnet" />Magnet</a>}{item.currentSnapshot?.torrentUrl && <a href={item.currentSnapshot.torrentUrl} target="_blank" rel="noreferrer"><Icon name="download" />Torrent file</a>}</div></div></section>}

        {item.type === "rule" && <section className="detail-section"><div className="section-heading"><h3>Matches</h3><span>{matches.length}</span></div>{matches.length ? <div className="match-list">{matches.map((match) => <a key={match.id} href={match.url} target="_blank" rel="noreferrer"><TrackerTag tracker={match.trackerKey} /><span><strong>{match.title}</strong><small>{relativeTime(match.discoveredAt)}</small></span><Icon name="external" /></a>)}</div> : <EmptyCompact text={item.initialized ? "No new releases matched this rule yet." : "The first baseline scan is pending."} />}</section>}

        <section className="detail-section"><div className="section-heading"><h3>Change history</h3><span>{events.length}</span></div>{events.length ? <div className="timeline">{events.map((event) => <div className="timeline-item" key={event.id}><span className={!event.readAt ? "timeline-dot timeline-dot--new" : "timeline-dot"} /><div><strong>{event.summary}</strong><small>{relativeTime(event.createdAt)}</small></div></div>)}</div> : <EmptyCompact text="Changes will appear here after the baseline." />}</section>

        <section className="detail-section detail-section--actions"><button className="button button--quiet" onClick={markRead}>{item.isUnread ? "Mark read" : "Mark unread"}</button><button className="button button--quiet" disabled={busy} onClick={() => void update({ enabled: !item.enabled }, item.enabled ? "Subscription paused" : "Subscription resumed")}>{item.enabled ? "Pause" : "Resume"}</button><button className="button button--danger" onClick={remove}><Icon name="trash" />Delete</button></section>
      </div>}
    </Drawer>
  );
}

function EditSubscriptionForm({ item, busy, onCancel, onSave }: { item: Subscription; busy: boolean; onCancel: () => void; onSave: (payload: Record<string, unknown>) => Promise<void> }) {
  const [url, setUrl] = useState(item.directUrl || "");
  const [required, setRequired] = useState<string[]>(item.requiredTerms);
  const [ignored, setIgnored] = useState<string[]>(item.ignoredTerms);
  const [trackerKeys, setTrackerKeys] = useState<TrackerKey[]>(item.trackerKeys);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const payload = item.type === "direct"
      ? { url }
      : { requiredTerms: required, ignoredTerms: ignored, trackerKeys };
    await onSave(payload);
  }

  return <form className="edit-subscription" onSubmit={submit}>
    {item.type === "direct" ? <Field label="Tracker page URL"><input type="url" value={url} onChange={(event) => setUrl(event.target.value)} required /></Field> : <>
      <Field label="Trackers"><div className="tracker-picker">{(["kinozal", "rutor", "rutracker"] as TrackerKey[]).map((tracker) => <label key={tracker} className={trackerKeys.includes(tracker) ? "tracker-choice tracker-choice--active" : "tracker-choice"}><input type="checkbox" checked={trackerKeys.includes(tracker)} onChange={() => setTrackerKeys((current) => current.includes(tracker) ? current.filter((key) => key !== tracker) : [...current, tracker])} /><TrackerTag tracker={tracker} /><span>{trackerName(tracker)}</span></label>)}</div></Field>
      <Field label="Required phrases" hint="Press Enter to add"><PhraseInput ariaLabel="Required phrases" value={required} onChange={setRequired} placeholder="Type a phrase and press Enter" /></Field>
      <Field label="Ignored phrases" hint="Press Enter to add"><PhraseInput ariaLabel="Ignored phrases" value={ignored} onChange={setIgnored} placeholder="Type a phrase and press Enter" /></Field>
    </>}
    <div className="inline-actions"><button type="button" className="button button--quiet" onClick={onCancel}>Cancel</button><button className="button button--primary" disabled={busy || (item.type === "rule" && (!required.length || !trackerKeys.length))}>Save changes</button></div>
  </form>;
}

type TrackerSettingsDraft = { mirror: string; username: string; password: string; saving: boolean };

function Settings({ notify }: { notify: Notify }) {
  const [telegram, setTelegram] = useState<TelegramStatus | null>(null);
  const [link, setLink] = useState<{ code: string; expiresAt: string; deepLink?: string } | null>(null);
  const [trackers, setTrackers] = useState<Tracker[]>([]);
  const [drafts, setDrafts] = useState<Partial<Record<TrackerKey, TrackerSettingsDraft>>>({});
  const [botToken, setBotToken] = useState("");
  const [telegramBusy, setTelegramBusy] = useState(false);

  const load = useCallback(async () => {
    const [telegramResult, trackerResult] = await Promise.all([
      api<{ telegram: TelegramStatus }>("/api/telegram"),
      api<{ trackers: Tracker[] }>("/api/trackers"),
    ]);
    setTelegram(telegramResult.telegram); setTrackers(trackerResult.trackers);
    setDrafts(Object.fromEntries(trackerResult.trackers.map((tracker) => [tracker.key, {
      mirror: tracker.hasOverride ? tracker.baseUrl : "",
      username: tracker.username || "",
      password: "",
      saving: false,
    }])) as Record<TrackerKey, TrackerSettingsDraft>);
  }, []);

  useEffect(() => { void load().catch((error) => notify(errorMessage(error), "bad")); }, [load, notify]);
  useEffect(() => {
    if (!telegram?.configured || telegram.linked) return;
    const interval = window.setInterval(() => {
      void api<{ telegram: TelegramStatus }>("/api/telegram").then((result) => setTelegram(result.telegram)).catch(() => undefined);
      setLink((current) => current && new Date(current.expiresAt).getTime() <= Date.now() ? null : current);
    }, 5_000);
    return () => window.clearInterval(interval);
  }, [telegram?.configured, telegram?.linked]);

  async function generateLink() {
    try { const result = await api<{ link: typeof link }>("/api/telegram/link-code", { method: "POST" }); setLink(result.link); }
    catch (error) { notify(errorMessage(error), "bad"); }
  }
  async function configureBot() {
    if (!botToken.trim()) return;
    setTelegramBusy(true);
    try {
      const result = await api<{ telegram: TelegramStatus }>("/api/telegram/bot", { method: "POST", ...jsonBody({ token: botToken }) });
      setTelegram(result.telegram); setBotToken(""); setLink(null); notify(result.telegram.botUsername ? `@${result.telegram.botUsername} configured` : "Telegram bot configured");
    } catch (error) { notify(errorMessage(error), "bad"); } finally { setTelegramBusy(false); }
  }
  async function removeBot() {
    if (!window.confirm("Remove this Telegram bot and unlink its chat?")) return;
    setTelegramBusy(true);
    try { await api("/api/telegram/bot", { method: "DELETE" }); setBotToken(""); setLink(null); await load(); notify("Telegram bot removed"); }
    catch (error) { notify(errorMessage(error), "bad"); } finally { setTelegramBusy(false); }
  }
  async function unlink() {
    if (!window.confirm("Unlink Telegram from this user?")) return;
    try { await api("/api/telegram", { method: "DELETE" }); setLink(null); await load(); notify("Telegram unlinked"); }
    catch (error) { notify(errorMessage(error), "bad"); }
  }
  async function saveTracker(tracker: Tracker) {
    const draft = drafts[tracker.key];
    if (!draft) return;
    setDrafts((current) => ({ ...current, [tracker.key]: { ...draft, saving: true } }));
    const payload: Record<string, unknown> = { baseUrl: draft.mirror.trim() || null };
    if (draft.username.trim()) payload.username = draft.username.trim();
    if (draft.password) payload.password = draft.password;
    try { await api(`/api/trackers/${tracker.key}/settings`, { method: "PUT", ...jsonBody(payload) }); await load(); notify(`${tracker.displayName} settings saved`); }
    catch (error) { setDrafts((current) => ({ ...current, [tracker.key]: { ...draft, saving: false } })); notify(errorMessage(error), "bad"); }
  }
  async function clearTrackerCredentials(tracker: Tracker) {
    if (!window.confirm(`Remove the stored ${tracker.displayName} login?`)) return;
    const draft = drafts[tracker.key];
    if (!draft) return;
    try { await api(`/api/trackers/${tracker.key}/settings`, { method: "PUT", ...jsonBody({ clearCredentials: true }) }); await load(); notify(`${tracker.displayName} login removed`); }
    catch (error) { notify(errorMessage(error), "bad"); }
  }
  return (
    <Page title="Settings" eyebrow="Delivery & access" description="Configure private tracker access and Telegram delivery for this account.">
      <section className="settings-section settings-section--top">
        <div className="settings-copy"><h2>Telegram bot</h2><p>Create a bot with BotFather, store its token securely, then link the private chat that should receive changes.</p></div>
        <div className="settings-control">
          {!telegram ? <ListSkeleton /> : <div className="telegram-setup">
            <div className="integration-heading"><span className="telegram-mark"><Icon name="send" /></span><span><strong>{telegram.configured ? `@${telegram.botUsername}` : "No bot configured"}</strong><small>{telegram.configured ? "Token encrypted in the local database" : "BotFather issues the token used by Torrentinel"}</small></span><a className="button button--quiet" href="https://t.me/BotFather" target="_blank" rel="noreferrer"><Icon name="external" />Create bot with BotFather</a></div>
            <label className="settings-field"><span>{telegram.configured ? "Replace bot token" : "Bot token"}</span><input type="password" value={botToken} onChange={(event) => setBotToken(event.target.value)} placeholder={telegram.configured ? "Stored securely — paste a token to replace" : "Paste the HTTP API token from BotFather"} autoComplete="new-password" /></label>
            <div className="integration-actions"><small>The token is validated with Telegram before it is encrypted and saved.</small>{telegram.configured && <button className="text-button text-button--danger" disabled={telegramBusy} onClick={() => void removeBot()}>Remove bot</button>}<button className="button button--quiet" disabled={telegramBusy || !botToken.trim()} onClick={() => void configureBot()}>{telegramBusy ? "Validating…" : telegram.configured ? "Replace token" : "Save bot"}</button></div>
            {telegram.configured && (telegram.linked ? <div className="linked-account"><span className="status-dot status-dot--live" /><span><strong>{telegram.telegramUsername ? `@${telegram.telegramUsername}` : "Telegram chat linked"}</strong><small>Notifications are active through @{telegram.botUsername}</small></span><button className="button button--quiet" onClick={() => void unlink()}>Unlink chat</button></div> : link ? <div className="link-code"><p>Open <strong>@{telegram.botUsername}</strong> and send <code>/start {link.code}</code>.</p><strong>{link.code}</strong>{link.deepLink && <a className="button button--primary" href={link.deepLink} target="_blank" rel="noreferrer"><Icon name="send" />Open Telegram</a>}<small>Expires {relativeTime(link.expiresAt)}</small></div> : <div className="link-prompt"><span><strong>Bot saved. Chat not linked.</strong><small>Generate a one-time code to connect this Torrentinel account.</small></span><button className="button button--primary" onClick={() => void generateLink()}><Icon name="send" />Link Telegram</button></div>)}
          </div>}
        </div>
      </section>

      <section className="settings-section settings-section--top">
        <div className="settings-copy"><h2>Tracker access</h2><p>Each account has private mirrors and logins. Password fields stay blank after saving and only replace a password when you type a new one.</p></div>
        <div className="tracker-settings-list">{trackers.map((tracker) => {
          const draft = drafts[tracker.key];
          if (!draft) return <ListSkeleton key={tracker.key} />;
          return <section className="tracker-settings-row" key={tracker.key}>
            <div className="integration-heading"><TrackerTag tracker={tracker.key} /><span><strong>{tracker.displayName}</strong><small>{tracker.key === "rutracker" ? tracker.credentialsConfigured ? `Public feed + protected details; login stored for ${tracker.username}` : "Public feed + protected detail resolver; login optional" : tracker.credentialsConfigured ? `Login stored for ${tracker.username}` : tracker.key === "kinozal" ? "Login required for polling" : "Login optional for this tracker"}</small></span><span className={`state ${tracker.credentialsConfigured || tracker.key !== "kinozal" ? "state--good" : "state--pending"}`}>{tracker.key === "rutracker" ? "Feed + details" : tracker.credentialsConfigured ? "Secured" : tracker.key === "kinozal" ? "Login missing" : "Public"}</span></div>
            <div className="tracker-settings-fields">
              <label className="settings-field settings-field--wide"><span>Mirror override</span><input type="url" value={draft.mirror} onChange={(event) => setDrafts((current) => ({ ...current, [tracker.key]: { ...draft, mirror: event.target.value } }))} placeholder={tracker.globalBaseUrl} /></label>
              <label className="settings-field"><span>Username</span><input value={draft.username} onChange={(event) => setDrafts((current) => ({ ...current, [tracker.key]: { ...draft, username: event.target.value } }))} autoComplete="off" /></label>
              <label className="settings-field"><span>Password</span><input type="password" value={draft.password} onChange={(event) => setDrafts((current) => ({ ...current, [tracker.key]: { ...draft, password: event.target.value } }))} placeholder={tracker.credentialsConfigured ? "Stored — type to replace" : "Password"} autoComplete="new-password" /></label>
            </div>
            <div className="integration-actions"><small>{tracker.hasOverride ? "Personal mirror active" : `Using global mirror ${tracker.globalBaseUrl}`}</small>{tracker.credentialsConfigured && <button className="text-button text-button--danger" onClick={() => void clearTrackerCredentials(tracker)}>Remove login</button>}<button className="button button--quiet" disabled={draft.saving || Boolean(draft.username.trim()) !== Boolean(draft.password || tracker.credentialsConfigured)} onClick={() => void saveTracker(tracker)}>{draft.saving ? "Saving…" : "Save settings"}</button></div>
          </section>;
        })}</div>
      </section>
    </Page>
  );
}

function Admin({ notify }: { notify: Notify }) {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [mirrors, setMirrors] = useState<AdminMirror[]>([]);
  const [status, setStatus] = useState<SchedulerStatus | null>(null);
  const [diagnostics, setDiagnostics] = useState<DiagnosticsResponse | null>(null);
  const [diagnosticTracker, setDiagnosticTracker] = useState<TrackerKey | "">("");
  const [diagnosticOutcome, setDiagnosticOutcome] = useState("");
  const [intervalMinutes, setIntervalMinutes] = useState(60);
  const [intervalIndex, setIntervalIndex] = useState(nearestPollIntervalIndex(60));
  const [createUser, setCreateUser] = useState(false);
  const [polling, setPolling] = useState(false);
  const [savingInterval, setSavingInterval] = useState(false);

  const load = useCallback(async () => {
    const [userResult, mirrorResult, statusResult, diagnosticResult] = await Promise.all([
      api<{ users: AdminUser[] }>("/api/admin/users"),
      api<{ mirrors: AdminMirror[] }>("/api/admin/mirrors"),
      api<{ scheduler: SchedulerStatus; intervalMinutes: number }>("/api/system/status"),
      api<DiagnosticsResponse>("/api/admin/diagnostics?limit=100"),
    ]);
    setUsers(userResult.users); setMirrors(mirrorResult.mirrors); setStatus(statusResult.scheduler);
    setDiagnostics(diagnosticResult);
    setIntervalMinutes(statusResult.intervalMinutes);
    setIntervalIndex(nearestPollIntervalIndex(statusResult.intervalMinutes));
  }, []);
  useEffect(() => { void load().catch((error) => notify(errorMessage(error), "bad")); }, [load, notify]);

  async function poll() {
    setPolling(true);
    try { await api<{ scheduler: SchedulerStatus }>("/api/system/poll", { method: "POST" }); await load(); notify("Tracker poll completed"); }
    catch (error) { notify(errorMessage(error), "bad"); } finally { setPolling(false); }
  }
  async function toggleUser(user: AdminUser) {
    try { await api(`/api/admin/users/${user.id}`, { method: "PATCH", ...jsonBody({ disabled: !user.disabled }) }); await load(); notify(user.disabled ? "User enabled" : "User disabled"); }
    catch (error) { notify(errorMessage(error), "bad"); }
  }
  async function resetUser(user: AdminUser) {
    const password = window.prompt(`Temporary password for ${user.username}`);
    if (!password) return;
    try { await api(`/api/admin/users/${user.id}/reset-password`, { method: "POST", ...jsonBody({ password }) }); notify("Password reset; the user must change it at sign-in"); }
    catch (error) { notify(errorMessage(error), "bad"); }
  }
  async function updateMirror(mirror: AdminMirror, baseUrl: string, enabled: boolean) {
    try { await api(`/api/admin/mirrors/${mirror.trackerKey}`, { method: "PUT", ...jsonBody({ baseUrl, enabled }) }); await load(); notify("Global mirror updated"); }
    catch (error) { notify(errorMessage(error), "bad"); }
  }
  async function applyPollInterval() {
    const minutes = POLL_INTERVAL_OPTIONS[intervalIndex];
    setSavingInterval(true);
    try {
      const result = await api<{ scheduler: SchedulerStatus; intervalMinutes: number }>("/api/admin/settings/poll-interval", {
        method: "PUT",
        ...jsonBody({ minutes }),
      });
      setStatus(result.scheduler);
      setIntervalMinutes(result.intervalMinutes);
      setIntervalIndex(nearestPollIntervalIndex(result.intervalMinutes));
      notify(`Polling interval set to ${formatPollInterval(result.intervalMinutes)}`);
    } catch (error) {
      notify(errorMessage(error), "bad");
    } finally {
      setSavingInterval(false);
    }
  }

  const selectedInterval = POLL_INTERVAL_OPTIONS[intervalIndex];
  const intervalChanged = selectedInterval !== intervalMinutes;
  const intervalProgress = intervalIndex / (POLL_INTERVAL_OPTIONS.length - 1) * 100;
  const diagnosticOutcomes = [...new Set((diagnostics?.observations || []).map((observation) => observation.outcome))].sort();
  const visibleDiagnostics = (diagnostics?.observations || []).filter((observation) => (
    (!diagnosticTracker || observation.trackerKey === diagnosticTracker)
    && (!diagnosticOutcome || observation.outcome === diagnosticOutcome)
  ));

  return (
    <Page title="Administration" eyebrow="Local service" description="Manage users, tracker access, polling, and diagnostic history." actions={<button className="button button--primary" onClick={() => setCreateUser(true)}><Icon name="plus" />New user</button>}>
      <section className="admin-strip"><div><span className={`status-dot ${status?.running ? "status-dot--live" : ""}`} /><span><strong>{status?.running ? "Poll in progress" : pollingCadence(intervalMinutes)}</strong><small>{status?.lastFinishedAt ? `Last completed ${relativeTime(status.lastFinishedAt)}` : "No completed poll yet"}</small></span></div><div className="run-metrics"><span><strong>{status?.checked || 0}</strong> sources</span><span><strong>{status?.changed || 0}</strong> changed</span><span><strong>{status?.errors || 0}</strong> errors</span></div><button className="button button--quiet" disabled={polling || status?.running} onClick={poll}><Icon name="refresh" />{polling ? "Polling…" : "Run now"}</button></section>

      <section className="admin-schedule" aria-labelledby="poll-interval-heading">
        <div className="schedule-copy"><span className="schedule-icon"><Icon name="clock" /></span><span><strong id="poll-interval-heading">Polling interval</strong><small>One schedule for every user and tracker</small></span></div>
        <div className="interval-control">
          <div className="interval-readout"><strong>{formatPollInterval(selectedInterval)}</strong><small>{intervalChanged ? `Currently ${formatPollInterval(intervalMinutes)}` : "Active schedule"}</small></div>
          <input
            className="interval-slider"
            type="range"
            min={0}
            max={POLL_INTERVAL_OPTIONS.length - 1}
            step={1}
            value={intervalIndex}
            aria-label="Polling interval"
            aria-valuetext={formatPollInterval(selectedInterval)}
            style={{ "--interval-progress": `${intervalProgress}%` } as CSSProperties}
            onChange={(event) => setIntervalIndex(Number(event.target.value))}
          />
          <div className="interval-scale" aria-hidden="true">
            {POLL_INTERVAL_MARKERS.map((minutes, markerIndex) => {
              const optionIndex = POLL_INTERVAL_OPTIONS.indexOf(minutes);
              const position = optionIndex / (POLL_INTERVAL_OPTIONS.length - 1) * 100;
              return <span key={minutes} className={markerIndex === 0 ? "scale-first" : markerIndex === POLL_INTERVAL_MARKERS.length - 1 ? "scale-last" : ""} style={{ left: `${position}%` }}>{shortPollInterval(minutes)}</span>;
            })}
          </div>
        </div>
        <button className="button button--quiet" disabled={!intervalChanged || savingInterval} onClick={() => void applyPollInterval()}>{savingInterval ? "Applying…" : "Apply interval"}</button>
      </section>

      <section className="table-section diagnostic-section">
        <div className="section-heading">
          <div><h2>Tracker logs</h2><p>Safe polling observations for investigating tracker behavior. Records expire after 168 hours.</p></div>
          <div className="diagnostic-controls">
            <select aria-label="Filter logs by tracker" value={diagnosticTracker} onChange={(event) => setDiagnosticTracker(event.target.value as TrackerKey | "")}>
              <option value="">All trackers</option>
              <option value="kinozal">Kinozal</option><option value="rutor">Rutor</option><option value="rutracker">RuTracker</option>
            </select>
            <select aria-label="Filter logs by outcome" value={diagnosticOutcome} onChange={(event) => setDiagnosticOutcome(event.target.value)}>
              <option value="">All outcomes</option>
              {diagnosticOutcomes.map((outcome) => <option key={outcome} value={outcome}>{outcome}</option>)}
            </select>
            <button className="button button--quiet" onClick={() => void load()}><Icon name="refresh" />Refresh</button>
          </div>
        </div>
        {!diagnostics ? <ListSkeleton /> : visibleDiagnostics.length === 0 ? <div className="diagnostic-empty">No tracker observations match these filters.</div> : <div className="diagnostic-table">
          <div className="diagnostic-head"><span>Observed</span><span>Source</span><span>Operation</span><span>Outcome</span><span>Details</span><span>Duration</span></div>
          {visibleDiagnostics.map((observation) => {
            const diagnosticUrl = observation.resolvedUrl || observation.requestedUrl;
            const detail = observation.errorMessage || observation.title || (observation.releaseCount !== null && observation.releaseCount !== undefined ? `${observation.releaseCount} releases observed` : "Tracker request completed");
            return <div className="diagnostic-row" key={observation.id}>
              <span className="diagnostic-time" title={new Date(observation.observedAt).toLocaleString()}>{relativeTime(observation.observedAt)}</span>
              <span className="diagnostic-source"><TrackerTag tracker={observation.trackerKey} /><span><strong>{trackerName(observation.trackerKey)}</strong><small>{observation.username}{observation.subscriptionId ? ` · subscription ${observation.subscriptionId}` : ""}</small></span></span>
              <span className="diagnostic-operation">{observation.operation.replace("-", " ")}</span>
              <span><span className={`state ${diagnosticStateClass(observation.outcome)}`}>{observation.outcome}</span></span>
              <span className="diagnostic-detail"><strong>{detail}</strong><small>{[observation.httpStatus ? `HTTP ${observation.httpStatus}` : "", observation.externalId ? `ID ${observation.externalId}` : ""].filter(Boolean).join(" · ")}</small>{diagnosticUrl && <a href={diagnosticUrl} target="_blank" rel="noreferrer">{diagnosticUrl}</a>}</span>
              <span className="diagnostic-duration">{formatDiagnosticDuration(observation.durationMs)}</span>
            </div>;
          })}
        </div>}
      </section>

      <section className="table-section"><div className="section-heading"><div><h2>Users</h2><p>Collections and subscription data are isolated by account.</p></div><span>{users.length}</span></div><div className="data-table user-table"><div className="table-head"><span>User</span><span>Role</span><span>Collections</span><span>Subscriptions</span><span>Status</span><span /></div>{users.map((user) => <div className="table-row" key={user.id}><span className="user-cell"><span className="avatar">{user.username[0].toUpperCase()}</span><span><strong>{user.username}</strong><small>Created {relativeTime(user.createdAt)}</small></span></span><span>{user.isAdmin ? "Administrator" : "Member"}</span><span>{user.collectionCount}</span><span>{user.subscriptionCount}</span><span><span className={`state ${user.disabled ? "state--error" : "state--good"}`}>{user.disabled ? "Disabled" : user.mustChangePassword ? "Password change" : "Active"}</span></span><span className="row-actions"><button className="text-button" onClick={() => void resetUser(user)}>Reset password</button><button className="text-button" onClick={() => void toggleUser(user)}>{user.disabled ? "Enable" : "Disable"}</button></span></div>)}</div></section>

      <section className="table-section"><div className="section-heading"><div><h2>Global mirrors</h2><p>Defaults used unless a user has a personal override.</p></div></div><div className="mirror-admin">{mirrors.map((mirror) => <AdminMirrorRow key={mirror.trackerKey} mirror={mirror} onSave={updateMirror} />)}</div></section>
      {createUser && <CreateUser onClose={() => setCreateUser(false)} onCreated={async () => { setCreateUser(false); await load(); }} notify={notify} />}
    </Page>
  );
}

function AdminMirrorRow({ mirror, onSave }: { mirror: AdminMirror; onSave: (mirror: AdminMirror, baseUrl: string, enabled: boolean) => Promise<void> }) {
  const [baseUrl, setBaseUrl] = useState(mirror.baseUrl);
  const [enabled, setEnabled] = useState(mirror.enabled);
  return <div className="mirror-row"><div><TrackerTag tracker={mirror.trackerKey} /><span><strong>{mirror.displayName}</strong><small>{mirror.enabled ? "Enabled" : "Disabled"}</small></span></div><input type="url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} /><label className="switch"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /><span /></label><button className="button button--quiet" onClick={() => void onSave(mirror, baseUrl, enabled)}>Save</button></div>;
}

function CreateUser({ onClose, onCreated, notify }: { onClose: () => void; onCreated: () => Promise<void>; notify: Notify }) {
  const [username, setUsername] = useState(""); const [password, setPassword] = useState(""); const [isAdmin, setIsAdmin] = useState(false); const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) { event.preventDefault(); setBusy(true); try { await api("/api/admin/users", { method: "POST", ...jsonBody({ username, password, isAdmin }) }); await onCreated(); notify("User created"); } catch (error) { notify(errorMessage(error), "bad"); } finally { setBusy(false); } }
  return <Drawer title="New user" subtitle="The account receives a private Inbox collection." onClose={onClose}><form onSubmit={submit}><Field label="Username"><input value={username} onChange={(event) => setUsername(event.target.value)} autoFocus required /></Field><Field label="Temporary password" hint="At least 8 characters"><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} minLength={8} required /></Field><label className="check-line"><input type="checkbox" checked={isAdmin} onChange={(event) => setIsAdmin(event.target.checked)} /><span><strong>Administrator</strong><small>Can manage users, global mirrors, and polling.</small></span></label><DrawerActions onCancel={onClose} busy={busy} label="Create user" /></form></Drawer>;
}

function Page({ title, eyebrow, description, actions, children }: { title: string; eyebrow: string; description: string; actions?: ReactNode; children: ReactNode }) {
  return <main className="page"><header className="page-header"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p>{description}</p></div>{actions}</header><div className="page-body">{children}</div></main>;
}

function Drawer({ title, subtitle, onClose, wide = false, extraWide = false, headerMedia, children }: { title: string; subtitle: string; onClose: () => void; wide?: boolean; extraWide?: boolean; headerMedia?: ReactNode; children: ReactNode }) {
  useEffect(() => { const key = (event: KeyboardEvent) => event.key === "Escape" && onClose(); window.addEventListener("keydown", key); return () => window.removeEventListener("keydown", key); }, [onClose]);
  return <div className="drawer-layer" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><aside className={`drawer ${wide ? "drawer--wide" : ""} ${extraWide ? "drawer--details" : ""}`} role="dialog" aria-modal="true" aria-label={title}><header><div className={`drawer-heading ${headerMedia ? "drawer-heading--with-media" : ""}`}>{headerMedia}<div className="drawer-heading__copy"><p className="eyebrow">{subtitle}</p><h2>{title}</h2></div></div><button className="icon-button" onClick={onClose} aria-label="Close"><Icon name="close" /></button></header><div className="drawer-body">{children}</div></aside></div>;
}

function DrawerActions({ onCancel, busy, label, disabled = false }: { onCancel: () => void; busy: boolean; label: string; disabled?: boolean }) {
  return <div className="drawer-actions"><button type="button" className="button button--quiet" onClick={onCancel}>Cancel</button><button className="button button--primary" disabled={busy || disabled}>{busy ? "Saving…" : label}</button></div>;
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <label className="field"><span><strong>{label}</strong>{hint && <small>{hint}</small>}</span>{children}</label>;
}

function PhraseInput({ ariaLabel, value, onChange, placeholder }: { ariaLabel: string; value: string[]; onChange: (value: string[]) => void; placeholder?: string }) {
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  function addDraft() {
    const phrase = draft.trim();
    if (!phrase) return;
    const duplicate = value.some((item) => item.toLocaleLowerCase() === phrase.toLocaleLowerCase());
    if (!duplicate) onChange([...value, phrase]);
    setDraft("");
  }

  function removePhrase(index: number) {
    onChange(value.filter((_, itemIndex) => itemIndex !== index));
  }

  return (
    <div className="phrase-input" onClick={() => inputRef.current?.focus()}>
      <input
        ref={inputRef}
        className="phrase-input__entry"
        aria-label={ariaLabel}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing) {
            event.preventDefault();
            addDraft();
          } else if (event.key === "Backspace" && !draft && value.length) {
            event.preventDefault();
            removePhrase(value.length - 1);
          }
        }}
        placeholder={value.length ? undefined : placeholder}
      />
      {value.map((phrase, index) => (
        <span className="phrase-chip" key={`${phrase}-${index}`}>
          <span>{phrase}</span>
          <button
            type="button"
            aria-label={`Remove phrase ${phrase}`}
            title={`Remove ${phrase}`}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => removePhrase(index)}
          >
            <Icon name="close" size={12} />
          </button>
        </span>
      ))}
    </div>
  );
}

function PhraseDisplay({ phrases }: { phrases: string[] }) {
  return (
    <span className="phrase-display" aria-label={phrases.join(", ")}>
      {phrases.map((phrase, index) => (
        <span className="phrase-chip phrase-chip--display" key={`${phrase}-${index}`}>
          <span>{phrase}</span>
        </span>
      ))}
    </span>
  );
}

function ReleaseCover({ url, title, thumbnail = false }: { url: string; title: string; thumbnail?: boolean }) {
  const [failed, setFailed] = useState(false);
  const className = `release-cover ${thumbnail ? "release-cover--thumbnail" : ""}`;
  if (failed) return <div className={`${className} release-cover--missing`}><Icon name="alert" size={thumbnail ? 15 : 20} /><span>Cover unavailable</span></div>;
  return (
    <div className={className}>
      <img className="release-cover__backdrop" src={url} alt="" aria-hidden="true" referrerPolicy="no-referrer" />
      <img className="release-cover__artwork" src={url} alt={`Cover for ${title}`} loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
    </div>
  );
}

function InfoLine({ icon, children }: { icon: IconName; children: ReactNode }) {
  return <div className="info-line"><Icon name={icon} /><span>{children}</span></div>;
}

function EmptyState({ icon, title, text, action }: { icon: IconName; title: string; text: string; action?: ReactNode }) {
  return <div className="empty-state"><span><Icon name={icon} size={32} /></span><h2>{title}</h2><p>{text}</p>{action}</div>;
}

function EmptyCompact({ text }: { text: string }) { return <div className="empty-compact">{text}</div>; }
function ListSkeleton() { return <div className="skeleton"><span /><span /><span /></div>; }
function TrackerTag({ tracker }: { tracker: TrackerKey }) { return <span className={`tracker-tag tracker-tag--${tracker}`} title={trackerName(tracker)}>{tracker === "rutracker" ? "RT" : tracker === "kinozal" ? "KZ" : "RU"}</span>; }

function BrandMark({ size = 32 }: { size?: number }) {
  return <img className="brand-mark" src="/brand/torrentinel-mark.svg" width={size} height={size} alt="" aria-hidden="true" />;
}

type IconName = "monitor" | "sliders" | "users" | "arrow" | "plus" | "clock" | "edit" | "trash" | "search" | "link" | "rule" | "folder" | "refresh" | "alert" | "external" | "magnet" | "download" | "send" | "close" | "bellAlert" | "check" | "unread";
function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  const symbols: Record<IconName, string> = {
    monitor: "monitor-eye",
    sliders: "settings",
    users: "shield",
    arrow: "resume",
    plus: "add",
    clock: "clock",
    edit: "settings",
    trash: "trash",
    search: "search",
    link: "link",
    rule: "keyword",
    folder: "hexagon",
    refresh: "sync",
    alert: "alert",
    external: "tracker",
    magnet: "magnet",
    download: "download",
    send: "bell",
    close: "add",
    bellAlert: "bell-alert",
    check: "check",
    unread: "unread",
  };
  return <svg className={`icon icon--${name}`} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true"><use href={`/brand/ui/sprite.svg#ti-${symbols[name]}`} /></svg>;
}

type Notify = (message: string, tone?: Toast["tone"]) => void;
function useSimpleRouter(): [string, (path: string) => void] {
  const currentPath = () => ["/", "/settings", "/admin"].includes(window.location.pathname)
    ? window.location.pathname
    : "/";
  const [path, setPath] = useState(currentPath);
  useEffect(() => {
    const handlePopState = () => setPath(currentPath());
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);
  const navigate = useCallback((nextPath: string) => {
    if (nextPath === path) return;
    window.history.pushState({}, "", nextPath);
    setPath(nextPath);
  }, [path]);
  return [path, navigate];
}
function capitalize(value: string): string { return value[0].toUpperCase() + value.slice(1); }
function trackerName(key: TrackerKey): string { return key === "rutracker" ? "RuTracker" : key === "kinozal" ? "Kinozal" : "Rutor"; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function relativeTime(value: string): string {
  const seconds = Math.round((new Date(value).getTime() - Date.now()) / 1_000);
  const abs = Math.abs(seconds);
  const formatter = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  if (abs < 60) return formatter.format(seconds, "second");
  if (abs < 3_600) return formatter.format(Math.round(seconds / 60), "minute");
  if (abs < 86_400) return formatter.format(Math.round(seconds / 3_600), "hour");
  if (abs < 2_592_000) return formatter.format(Math.round(seconds / 86_400), "day");
  return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric", year: new Date(value).getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
}

function nearestPollIntervalIndex(minutes: number): number {
  return POLL_INTERVAL_OPTIONS.reduce((bestIndex, option, index) => (
    Math.abs(option - minutes) < Math.abs(POLL_INTERVAL_OPTIONS[bestIndex] - minutes) ? index : bestIndex
  ), 0);
}

function formatPollInterval(minutes: number): string {
  if (minutes < 60) return `${minutes} minutes`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (!remainder) return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  return `${hours}h ${remainder}m`;
}

function shortPollInterval(minutes: number): string {
  return minutes < 60 ? `${minutes}m` : `${minutes / 60}h`;
}

function pollingCadence(minutes: number): string {
  if (minutes === 60) return "Polling every hour";
  return `Polling every ${formatPollInterval(minutes)}`;
}

function diagnosticStateClass(outcome: string): string {
  if (["error", "missing", "blocked", "auth", "parse", "network", "unsupported"].includes(outcome)) return "state--error";
  if (["changed", "new-matches"].includes(outcome)) return "state--updated";
  if (["temporarily-unavailable", "challenge"].includes(outcome)) return "state--pending";
  return "state--good";
}

function formatDiagnosticDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${durationMs} ms`;
  return `${(durationMs / 1_000).toFixed(durationMs < 10_000 ? 1 : 0)} s`;
}
