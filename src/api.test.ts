import { afterEach, expect, it, vi } from "vitest";
import { api, ApiError, onSessionExpired, SessionExpiredError } from "./api";

const respond = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
afterEach(() => { vi.unstubAllGlobals(); });

it("reports an expired session for a 401 from any authenticated endpoint", async () => {
  vi.stubGlobal("fetch", respond(401, { error: "Authentication required" }));
  const listener = vi.fn(), stop = onSessionExpired(listener);
  try {
    const failure = await api("/api/collections").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SessionExpiredError);
    expect(failure).toMatchObject({ status: 401, code: "SESSION_EXPIRED", message: "Your session has expired. Sign in again." });
    expect(listener).toHaveBeenCalledOnce();
  } finally { stop(); }
});

it("keeps sign-in failures and other errors as ordinary API errors", async () => {
  const listener = vi.fn(), stop = onSessionExpired(listener);
  try {
    vi.stubGlobal("fetch", respond(401, { error: "Invalid username or password" }));
    const login = await api("/api/auth/login", { method: "POST" }).catch((error: unknown) => error);
    expect(login).not.toBeInstanceOf(SessionExpiredError);
    expect(login).toMatchObject({ status: 401, message: "Invalid username or password" });
    vi.stubGlobal("fetch", respond(403, { error: "Administrator access required" }));
    const forbidden = await api("/api/admin/users").catch((error: unknown) => error);
    expect(forbidden).toBeInstanceOf(ApiError);
    expect(forbidden).not.toBeInstanceOf(SessionExpiredError);
    expect(listener).not.toHaveBeenCalled();
  } finally { stop(); }
  vi.stubGlobal("fetch", respond(401, {}));
  await api("/api/collections").catch(() => undefined);
  expect(listener).not.toHaveBeenCalled();
});
