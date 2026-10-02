import { type FormEvent, useState } from "react";
import { api, jsonBody } from "../api";
import { BrandMark, Field } from "../components/UI";
import { errorMessage } from "../format";
import { setLanguage, useI18n, type Language } from "../i18n";
import type { Notify, User } from "../types";

export function BootScreen() { const { t } = useI18n(); return <div className="boot-screen"><BrandMark size={42} /><span>{t("Starting Torrentinel")}</span><span className="loading-line" /></div>; }
export function Login({ onLogin, notify, initialUsername = "" }: { onLogin: (user: User) => void; notify: Notify; initialUsername?: string }) {
  const { t, language } = useI18n();
  const [username, setUsername] = useState(initialUsername), [password, setPassword] = useState(""), [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true);
    try { const result = await api<{ user: User }>("/api/auth/login", { method: "POST", ...jsonBody({ username, password }) }); onLogin(result.user); }
    catch (error) { notify(errorMessage(error), "bad"); } finally { setBusy(false); }
  }
  return <main className="login-page"><section className="login-brand"><BrandMark size={54} /><div><p className="eyebrow">{t("Private release monitor")}</p><h1>Torrentinel</h1><p>{t("Track change. Catch the release.")}</p></div></section><form className="login-form" onSubmit={submit}><p className="eyebrow">{t("Local access")}</p><h2>{t("Sign in")}</h2><Field label={t("Username")}><input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" autoFocus={!initialUsername} required /></Field><Field label={t("Password")}><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" autoFocus={Boolean(initialUsername)} required /></Field><button className="button button--primary button--wide" disabled={busy}>{t(busy ? "Signing in…" : "Sign in")}</button><Field label={t("Language")}><select value={language} onChange={(event) => setLanguage(event.target.value as Language)}><option value="en">English</option><option value="ru">Русский</option></select></Field></form></main>;
}
export function ChangePassword({ user, onChanged, onSignOut, notify }: { user: User; onChanged: (user: User) => void; onSignOut: () => void; notify: Notify }) {
  const { t } = useI18n();
  const [currentPassword, setCurrentPassword] = useState(""), [newPassword, setNewPassword] = useState(""), [confirm, setConfirm] = useState(""), [busy, setBusy] = useState(false);
  // Administrators see the first-run wording; members always arrive with a temporary password set by an administrator.
  const copy = user.isAdmin
    ? { eyebrow: "First sign-in", title: "Secure the admin account.", text: "The default password cannot be used after setup." }
    : { eyebrow: "Password change required", title: "Choose a new password.", text: "Your account uses a temporary password. Enter it, then choose a new one to continue." };
  async function submit(event: FormEvent) {
    event.preventDefault(); if (newPassword !== confirm) return notify(t("New passwords do not match"), "bad"); setBusy(true);
    try { const result = await api<{ user: User }>("/api/auth/change-password", { method: "POST", ...jsonBody({ currentPassword, newPassword }) }); onChanged(result.user); notify(t("Password changed")); }
    catch (error) { notify(errorMessage(error), "bad"); } finally { setBusy(false); }
  }
  return <main className="password-page"><section className="password-panel"><BrandMark size={40} /><p className="eyebrow">{t(copy.eyebrow)}</p><h1>{t(copy.title)}</h1><p>{t(copy.text)}</p><form onSubmit={submit}><Field label={t(user.isAdmin ? "Current password" : "Temporary password")}><input type="password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} autoFocus required /></Field><Field label={t("New password")}><input type="password" minLength={8} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} required /></Field><Field label={t("Confirm new password")}><input type="password" minLength={8} value={confirm} onChange={(event) => setConfirm(event.target.value)} required /></Field><button className="button button--primary button--wide" disabled={busy}>{t("Save new password")}</button></form><button type="button" className="text-button password-sign-out" onClick={onSignOut}>{t("Sign out")}</button></section></main>;
}
