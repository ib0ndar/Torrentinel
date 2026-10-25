import { type FormEvent, useId, useRef, useState } from "react";
import { api, ApiError, jsonBody } from "../api";
import { Icon } from "../components/Icon";
import { BrandMark, Field, PasswordField } from "../components/UI";
import { errorMessage } from "../format";
import { type Language, LANGUAGES, setLanguage, useI18n } from "../i18n";
import { usePageTitle } from "../pageTitle";
import type { Notify, User } from "../types";

export function BootScreen() { const { t } = useI18n(); return <div className="boot-screen"><BrandMark size={42} /><span>{t("Starting Torrentinel")}</span><span className="loading-line" /></div>; }
// Sign-in errors stay in the form until the next attempt; rejected credentials clear the password and focus it.
// The language switch is a page setting, so it sits in the corner rather than among the credentials.
export function Login({ onLogin, initialUsername = "" }: { onLogin: (user: User) => void; initialUsername?: string }) {
  const { t, language } = useI18n();
  usePageTitle(t("Sign in"));
  const [username, setUsername] = useState(initialUsername), [password, setPassword] = useState(""), [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; credentials: boolean } | null>(null);
  const passwordRef = useRef<HTMLInputElement>(null), errorId = useId();
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(null);
    try { const result = await api<{ user: User }>("/api/auth/login", { method: "POST", ...jsonBody({ username, password }) }); onLogin(result.user); }
    catch (failure) {
      const credentials = failure instanceof ApiError && failure.status === 401;
      setError({ message: errorMessage(failure), credentials });
      if (credentials) { setPassword(""); passwordRef.current?.focus(); }
    } finally { setBusy(false); }
  }
  return <main className="login-page"><section className="login-brand"><BrandMark size={54} /><div><p className="eyebrow">{t("Private release monitor")}</p><h1>Torrentinel</h1><p>{t("Track change. Catch the release.")}</p></div></section>
    <form className="login-form" onSubmit={submit}><p className="eyebrow">{t("Local access")}</p><h2>{t("Sign in")}</h2>
      <Field label={t("Username")}><input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" autoFocus={!initialUsername} required /></Field>
      <PasswordField label={t("Password")} inputRef={passwordRef} value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" autoFocus={Boolean(initialUsername)} required aria-invalid={error?.credentials || undefined} aria-describedby={error ? errorId : undefined} />
      {error && <div id={errorId} className="form-error login-error" role="alert"><Icon name="alert" size={16} /><span>{error.message}</span></div>}
      <button className={`button button--primary button--wide ${busy ? "button--busy" : ""}`} disabled={busy}>{busy && <span className="button-spinner" aria-hidden="true" />}{t(busy ? "Signing in…" : "Sign in")}</button>
    </form>
    <LanguageSwitch language={language} />
  </main>;
}
function LanguageSwitch({ language }: { language: Language }) {
  const { t } = useI18n();
  return <div className="login-language" role="group" aria-label={t("Language")}>{LANGUAGES.map((item) => <button key={item.id} type="button" lang={item.id} aria-pressed={language === item.id} onClick={() => setLanguage(item.id)}>{item.name}</button>)}</div>;
}
// The same corner language switch as sign-in: the account's language may not be the one this person reads.
export function ChangePassword({ user, onChanged, onSignOut, notify }: { user: User; onChanged: (user: User) => void; onSignOut: () => void; notify: Notify }) {
  const { t, language } = useI18n();
  usePageTitle(t("New password"));
  const [currentPassword, setCurrentPassword] = useState(""), [newPassword, setNewPassword] = useState(""), [confirm, setConfirm] = useState(""), [busy, setBusy] = useState(false);
  // Only the first-run default administrator sees the setup wording; resets and accounts created with a temporary
  // password get their own. Older servers send no reason, so administrators then fall back to the first-run case.
  const reason = user.passwordChangeReason ?? (user.isAdmin ? "initial" : "created");
  const firstRun = reason === "initial" && user.isAdmin;
  const copy = reason === "reset"
    ? { eyebrow: "Password reset", title: "Choose a new password", text: "An administrator reset your password. Enter the temporary password you were given, then choose a new one to continue." }
    : firstRun
      ? { eyebrow: "First sign-in", title: "Secure the admin account", text: "Replace the initial password with one of your own." }
      : { eyebrow: "Password change required", title: "Choose a new password", text: "Your account uses a temporary password. Enter it, then choose a new one to continue." };
  async function submit(event: FormEvent) {
    event.preventDefault(); if (newPassword !== confirm) return notify(t("New passwords do not match"), "bad"); setBusy(true);
    try { const result = await api<{ user: User }>("/api/auth/change-password", { method: "POST", ...jsonBody({ currentPassword, newPassword }) }); onChanged(result.user); notify(t("Password changed")); }
    catch (error) { notify(errorMessage(error), "bad"); } finally { setBusy(false); }
  }
  return <main className="password-page"><section className="password-panel"><BrandMark size={40} /><p className="eyebrow">{t(copy.eyebrow)}</p><h1>{t(copy.title)}</h1><p>{t(copy.text)}</p><form onSubmit={submit}><PasswordField label={t(firstRun ? "Current password" : "Temporary password")} value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} autoComplete="current-password" autoFocus required />
      <PasswordField label={t("New password")} hint={t("At least {count} characters", { count: 8 })} minLength={8} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} autoComplete="new-password" required />
      <PasswordField label={t("Confirm new password")} minLength={8} value={confirm} onChange={(event) => setConfirm(event.target.value)} autoComplete="new-password" required /><button className="button button--primary button--wide" disabled={busy}>{t("Save new password")}</button></form><button type="button" className="text-button password-sign-out" onClick={onSignOut}>{t("Sign out")}</button></section>
    <LanguageSwitch language={language} /></main>;
}
