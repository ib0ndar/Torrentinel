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

// A 401 from any endpoint other than sign-in means the session cookie is no
// longer valid (expired, signed out elsewhere, server data reset, or account disabled).
export class SessionExpiredError extends ApiError {
  constructor() {
    super(SESSION_EXPIRED_MESSAGE, 401, "SESSION_EXPIRED");
    this.name = "SessionExpiredError";
  }
}

const sessionExpiredListeners = new Set<() => void>();
export function onSessionExpired(listener: () => void): () => void {
  sessionExpiredListeners.add(listener);
  return () => { sessionExpiredListeners.delete(listener); };
}
export function expireSession(): void {
  for (const listener of [...sessionExpiredListeners]) listener();
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
    expireSession();
    throw new SessionExpiredError();
  }
  if (!response.ok) {
    throw new ApiError(payload.error || `Request failed with HTTP ${response.status}`, response.status, payload.code, payload.details);
  }
  return payload as T;
}

export function jsonBody(value: unknown): Pick<RequestInit, "body"> {
  return { body: JSON.stringify(value) };
}
