import { type FormEvent, useState } from "react";
import { api, jsonBody } from "../../api";
import { Drawer, DrawerActions, Field } from "../../components/UI";
import { errorMessage, relativeTime } from "../../format";
import { useI18n } from "../../i18n";
import type { AdminUser, Notify } from "../../types";

export function UsersTab({ users, onResetPassword, onToggle }: { users: AdminUser[]; onResetPassword: (user: AdminUser) => void; onToggle: (user: AdminUser) => void }) {
  const { t } = useI18n();
  return <section className="table-section">
    <div className="section-heading">
      <div><h2>{t("Users")}</h2><p>{t("Collections and subscription data are isolated by account.")}</p></div>
      <span>{users.length}</span>
    </div>
    <div className="data-table user-table">
      <div className="table-head"><span>{t("User")}</span><span>{t("Role")}</span><span>{t("Collections")}</span><span>{t("Subscriptions")}</span><span>{t("Status")}</span><span /></div>
      {users.map((user) => <div className="table-row" key={user.id}>
        <span className="user-cell">
          <span className="avatar">{user.username[0].toUpperCase()}</span>
          <span><strong>{user.username}</strong><small>{t("Created {time}", { time: relativeTime(user.createdAt) })}</small></span>
        </span>
        <span>{t(user.isAdmin ? "Administrator" : "Member")}</span>
        <span>{user.collectionCount}</span>
        <span>{user.subscriptionCount}</span>
        <span><span className={`state ${user.disabled ? "state--error" : "state--good"}`}>{t(user.disabled ? "Disabled" : user.mustChangePassword ? "Password change" : "Active")}</span></span>
        <span className="row-actions">
          <button className="text-button" onClick={() => onResetPassword(user)}>{t("Reset password")}</button>
          <button className="text-button" onClick={() => onToggle(user)}>{t(user.disabled ? "Enable" : "Disable")}</button>
        </span>
      </div>)}
    </div>
  </section>;
}

export function CreateUser({ onClose, onCreated, notify }: { onClose: () => void; onCreated: () => Promise<void>; notify: Notify }) {
  const { t } = useI18n();
  const [username, setUsername] = useState(""), [password, setPassword] = useState(""), [isAdmin, setIsAdmin] = useState(false), [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true);
    try { await api("/api/admin/users", { method: "POST", ...jsonBody({ username, password, isAdmin }) }); await onCreated(); notify(t("User created")); }
    catch (error) { notify(errorMessage(error), "bad"); } finally { setBusy(false); }
  }
  return <Drawer title={t("New user")} subtitle={t("The account receives a private Inbox collection.")} onClose={onClose}>
    <form onSubmit={submit}>
      <Field label={t("Username")}><input value={username} onChange={(event) => setUsername(event.target.value)} autoFocus required /></Field>
      <Field label={t("Temporary password")} hint={t("At least 8 characters")}><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} minLength={8} required /></Field>
      <label className="check-line">
        <input type="checkbox" checked={isAdmin} onChange={(event) => setIsAdmin(event.target.checked)} />
        <span><strong>{t("Administrator")}</strong><small>{t("Can manage users, global mirrors, and polling.")}</small></span>
      </label>
      <DrawerActions onCancel={onClose} busy={busy} label={t("Create user")} />
    </form>
  </Drawer>;
}
