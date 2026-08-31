import { afterEach, describe, expect, it, vi } from "vitest";
import { CookieSession, TrackerHttpError } from "./http.js";

afterEach(() => vi.unstubAllGlobals());

describe("tracker HTTP transport", () => {
  it("classifies verification-style HTTP failures", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("Forbidden", { status: 403 })));
    const request = new CookieSession().get("https://tracker.test/protected");
    await expect(request).rejects.toMatchObject<Partial<TrackerHttpError>>({ code: "challenge", status: 403, retryable: true });
  });

  it("retains cookies and clears authentication state on reset", async () => {
    const seenCookies: Array<string | null> = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seenCookies.push(headers.get("cookie"));
      return new Response("ok", { status: 200, headers: { "set-cookie": "session=fixture; Path=/" } });
    }));
    const session = new CookieSession();
    await session.get("https://tracker.test/one");
    session.authenticated = true;
    await session.get("https://tracker.test/two");
    session.clear();
    await session.get("https://tracker.test/three");
    expect(seenCookies).toEqual([null, "session=fixture", null]);
    expect(session.authenticated).toBe(false);
  });

  it("reuses browser clearance without exposing login values to the resolver", async () => {
    let seenHeaders = new Headers();
    let seenBody = "";
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      seenHeaders = new Headers(init?.headers);
      seenBody = String(init?.body || "");
      return new Response("ok", { status: 200 });
    }));
    const session = new CookieSession();
    session.seedCookies([{ name: "cf_clearance", value: "browser-cookie" }], "Validated browser agent");

    await session.postForm("https://tracker.test/login", {
      login_username: "user",
      login_password: "password",
    }, undefined, { origin: "https://tracker.test" });

    expect(seenHeaders.get("cookie")).toBe("cf_clearance=browser-cookie");
    expect(seenHeaders.get("user-agent")).toBe("Validated browser agent");
    expect(seenHeaders.get("origin")).toBe("https://tracker.test");
    expect(seenBody).toBe("login_username=user&login_password=password");
  });
});
