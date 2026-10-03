import { type FormEvent, type Ref, useEffect, useRef, useState } from "react";
import { api, jsonBody } from "../../api";
import { Icon } from "../../components/Icon";
import { errorMessage } from "../../format";
import { useI18n } from "../../i18n";
import type { Notify, User } from "../../types";
import { SettingsSection } from "./SettingsSection";

const MINIMUM_PASSWORD_LENGTH = 8;

export function AccountSection({ user, notify, focusRequest, onFocused }: { user: User; notify: Notify; focusRequest: number; onFocused?: () => void }) {
  const { t } = useI18n();
  return <SettingsSection id="account" description={t("Change the password for {name}. Other browsers and devices signed in to this account are signed out.", { name: user.username })}>
    <AccountForm user={user} notify={notify} focusRequest={focusRequest} onFocused={onFocused} />
  </SettingsSection>;
}

// Self-service password change; the server keeps this session and signs out the account's other sessions.
function AccountForm({ user, notify, focusRequest, onFocused }: { user: User; notify: Notify; focusRequest: number; onFocused?: () => void }) {
  const { t } = useI18n();
  const [currentPassword, setCurrentPassword] = useState(""), [newPassword, setNewPassword] = useState(""), [confirm, setConfirm] = useState(""), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const currentRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!focusRequest) return;
    document.getElementById("account")?.scrollIntoView?.({ block: "start" });
    currentRef.current?.focus({ preventScroll: true });
    onFocused?.();
  }, [focusRequest]); // onFocused only resets the request.
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (newPassword.length < MINIMUM_PASSWORD_LENGTH) return setError(t("The new password must have at least {count} characters", { count: MINIMUM_PASSWORD_LENGTH }));
    if (newPassword !== confirm) return setError(t("New passwords do not match"));
    setError(""); setBusy(true);
    try {
      await api("/api/auth/change-password", { method: "POST", ...jsonBody({ currentPassword, newPassword }) });
      setCurrentPassword(""); setNewPassword(""); setConfirm(""); notify(t("Password changed"));
    } catch (failure) { setError(errorMessage(failure)); } finally { setBusy(false); }
  }
  const field = (label: string, value: string, change: (value: string) => void, autoComplete: string, ref?: Ref<HTMLInputElement>) =>
    <label className="settings-field">
      <span>{label}</span>
      <input ref={ref} type="password" value={value} onChange={(event) => { change(event.target.value); setError(""); }} autoComplete={autoComplete} required maxLength={500}
        aria-invalid={error ? true : undefined} aria-describedby={error ? "account-error" : undefined} />
    </label>;
  return <form className="settings-control account-form" onSubmit={(event) => void submit(event)} noValidate>
    <input type="text" name="username" autoComplete="username" value={user.username} readOnly hidden />
    {field(t("Current password"), currentPassword, setCurrentPassword, "current-password", currentRef)}
    <div className="account-form__new">
      {field(t("New password"), newPassword, setNewPassword, "new-password")}
      {field(t("Confirm new password"), confirm, setConfirm, "new-password")}
    </div>
    {error && <p className="form-error" id="account-error" role="alert"><Icon name="alert" size={15} />{error}</p>}
    <div className="integration-actions">
      <small>{t("At least {count} characters", { count: MINIMUM_PASSWORD_LENGTH })}</small>
      <button type="submit" className="button button--quiet" disabled={busy || !currentPassword || !newPassword || !confirm}>{t(busy ? "Saving…" : "Change password")}</button>
    </div>
  </form>;
}
