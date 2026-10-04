export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const SESSION_EXPIRED_MESSAGE = "Your session has expired. Sign in again.";
// The server says why when someone else ended the session (code SESSION_ENDED, details.reason).
export type SessionEndReason = "password-reset" | "password-changed" | "account-disabled";
const SESSION_END_MESSAGES: Record<SessionEndReason, string> = {
  "password-reset": "An administrator reset your password. Sign in with the temporary password you were given.",
  "password-changed": "Your password was changed in another session. Sign in with the new password.",
  "account-disabled": "An administrator disabled your account.",
};
export function sessionEndMessage(reason?: SessionEndReason): string { return reason ? SESSION_END_MESSAGES[reason] : SESSION_EXPIRED_MESSAGE; }
function sessionEndReason(payload: { code?: string; details?: unknown }): SessionEndReason | undefined {
  const reason = payload.code === "SESSION_ENDED" ? (payload.details as { reason?: unknown } | undefined)?.reason : undefined;
  return typeof reason === "string" && reason in SESSION_END_MESSAGES ? reason as SessionEndReason : undefined;
}

// A 401 from any endpoint other than sign-in means the session cookie is no
// longer valid (expired, signed out elsewhere, server data reset, or account disabled).
export class SessionExpiredError extends ApiError {
  constructor(public readonly reason?: SessionEndReason) {
    super(sessionEndMessage(reason), 401, "SESSION_EXPIRED");
    this.name = "SessionExpiredError";
  }
}

const sessionExpiredListeners = new Set<(reason?: SessionEndReason) => void>();
export function onSessionExpired(listener: (reason?: SessionEndReason) => void): () => void {
  sessionExpiredListeners.add(listener);
  return () => { sessionExpiredListeners.delete(listener); };
}
export function expireSession(reason?: SessionEndReason): void {
  for (const listener of [...sessionExpiredListeners]) listener(reason);
}

export const PASSWORD_CHANGE_MESSAGE = "Choose a new password to continue.";

// A 428 means the session is valid but an administrator reset the password
// (or it is still temporary), so only the password change endpoint is usable.
export class PasswordChangeRequiredError extends ApiError {
  constructor() {
    super(PASSWORD_CHANGE_MESSAGE, 428, "PASSWORD_CHANGE_REQUIRED");
    this.name = "PasswordChangeRequiredError";
  }
}

const passwordChangeListeners = new Set<() => void>();
export function onPasswordChangeRequired(listener: () => void): () => void {
  passwordChangeListeners.add(listener);
  return () => { passwordChangeListeners.delete(listener); };
}
export function requirePasswordChange(): void {
  for (const listener of [...passwordChangeListeners]) listener();
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(path, { ...options, headers, credentials: "same-origin" });
  const payload = await response.json().catch(() => ({})) as {
    error?: string;
    code?: string;
    details?: unknown;
  };
  if (response.status === 401 && path !== "/api/auth/login") {
    const reason = sessionEndReason(payload);
    expireSession(reason);
    throw new SessionExpiredError(reason);
  }
  if (response.status === 428 && payload.code === "PASSWORD_CHANGE_REQUIRED") {
    requirePasswordChange();
    throw new PasswordChangeRequiredError();
  }
  if (!response.ok) {
    throw new ApiError(payload.error || `Request failed with HTTP ${response.status}`, response.status, payload.code, payload.details);
  }
  return payload as T;
}

export function jsonBody(value: unknown): Pick<RequestInit, "body"> {
  return { body: JSON.stringify(value) };
}
