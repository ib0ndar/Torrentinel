import { type FormEvent, useId, useRef, useState } from "react";
import { api, ApiError, jsonBody } from "../api";
import { Icon } from "../components/Icon";
import { BrandMark, Field } from "../components/UI";
import { errorMessage } from "../format";
import { LANGUAGES, setLanguage, useI18n } from "../i18n";
import type { Notify, User } from "../types";

export function BootScreen() { const { t } = useI18n(); return <div className="boot-screen"><BrandMark size={42} /><span>{t("Starting Torrentinel")}</span><span className="loading-line" /></div>; }
// Sign-in errors stay in the form until the next attempt; rejected credentials clear the password and focus it.
// The language switch is a page setting, so it sits in the corner rather than among the credentials.
export function Login({ onLogin, initialUsername = "" }: { onLogin: (user: User) => void; initialUsername?: string }) {
  const { t, language } = useI18n();
  const [username, setUsername] = useState(initialUsername), [password, setPassword] = useState(""), [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; credentials: boolean } | null>(null), [passwordShown, setPasswordShown] = useState(false);
  const passwordRef = useRef<HTMLInputElement>(null), passwordId = useId(), errorId = useId();
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
      {/* Not a <label> wrapper: the toggle's own name would become part of the password field's name. */}
      <div className="field"><span><label htmlFor={passwordId}><strong>{t("Password")}</strong></label></span><div className="password-input">
        <input ref={passwordRef} id={passwordId} type={passwordShown ? "text" : "password"} value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" autoFocus={Boolean(initialUsername)} required aria-invalid={error?.credentials || undefined} aria-describedby={error ? errorId : undefined} />
        <button type="button" className="password-input__toggle" aria-controls={passwordId} aria-label={t(passwordShown ? "Hide password" : "Show password")} title={t(passwordShown ? "Hide password" : "Show password")} onClick={() => setPasswordShown((shown) => !shown)}><Icon name={passwordShown ? "hide" : "show"} /></button>
      </div></div>
      {error && <div id={errorId} className="form-error login-error" role="alert"><Icon name="alert" size={16} /><span>{error.message}</span></div>}
      <button className={`button button--primary button--wide ${busy ? "button--busy" : ""}`} disabled={busy}>{busy && <span className="button-spinner" aria-hidden="true" />}{t(busy ? "Signing in…" : "Sign in")}</button>
    </form>
    <div className="login-language" role="group" aria-label={t("Language")}>{LANGUAGES.map((item) => <button key={item.id} type="button" lang={item.id} aria-pressed={language === item.id} onClick={() => setLanguage(item.id)}>{item.name}</button>)}</div>
  </main>;
}
export function ChangePassword({ user, onChanged, onSignOut, notify }: { user: User; onChanged: (user: User) => void; onSignOut: () => void; notify: Notify }) {
  const { t } = useI18n();
  const [currentPassword, setCurrentPassword] = useState(""), [newPassword, setNewPassword] = useState(""), [confirm, setConfirm] = useState(""), [busy, setBusy] = useState(false);
  // Only the first-run default administrator sees the setup wording; resets and accounts created with a temporary
  // password get their own. Older servers send no reason, so administrators then fall back to the first-run case.
  const reason = user.passwordChangeReason ?? (user.isAdmin ? "initial" : "created");
  const firstRun = reason === "initial" && user.isAdmin;
  const copy = reason === "reset"
    ? { eyebrow: "Password reset", title: "Choose a new password.", text: "An administrator reset your password. Enter the temporary password you were given, then choose a new one to continue." }
    : firstRun
      ? { eyebrow: "First sign-in", title: "Secure the admin account.", text: "Replace the initial password with one of your own." }
      : { eyebrow: "Password change required", title: "Choose a new password.", text: "Your account uses a temporary password. Enter it, then choose a new one to continue." };
  async function submit(event: FormEvent) {
    event.preventDefault(); if (newPassword !== confirm) return notify(t("New passwords do not match"), "bad"); setBusy(true);
    try { const result = await api<{ user: User }>("/api/auth/change-password", { method: "POST", ...jsonBody({ currentPassword, newPassword }) }); onChanged(result.user); notify(t("Password changed")); }
    catch (error) { notify(errorMessage(error), "bad"); } finally { setBusy(false); }
  }
  return <main className="password-page"><section className="password-panel"><BrandMark size={40} /><p className="eyebrow">{t(copy.eyebrow)}</p><h1>{t(copy.title)}</h1><p>{t(copy.text)}</p><form onSubmit={submit}><Field label={t(firstRun ? "Current password" : "Temporary password")}><input type="password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} autoFocus required /></Field><Field label={t("New password")}><input type="password" minLength={8} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} required /></Field><Field label={t("Confirm new password")}><input type="password" minLength={8} value={confirm} onChange={(event) => setConfirm(event.target.value)} required /></Field><button className="button button--primary button--wide" disabled={busy}>{t("Save new password")}</button></form><button type="button" className="text-button password-sign-out" onClick={onSignOut}>{t("Sign out")}</button></section></main>;
}
