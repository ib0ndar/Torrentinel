import { afterEach, describe, expect, it, vi } from "vitest";
import { CookieSession, TrackerHttpError } from "./http.js";

afterEach(() => vi.unstubAllGlobals());

describe("tracker HTTP transport", () => {
  it("classifies verification-style HTTP failures", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("Forbidden", { status: 403 })));
    const request = new CookieSession().get("https://tracker.test/protected");
    await expect(request).rejects.toMatchObject({ code: "challenge", status: 403, retryable: true } satisfies Partial<TrackerHttpError>);
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
    session.seedCookies([{ name: "cf_clearance", value: "browser-cookie" }], "Validated browser agent", "https://tracker.test/login");

    await session.postForm("https://tracker.test/login", {
      login_username: "user",
      login_password: "password",
    }, undefined, { origin: "https://tracker.test" });

    expect(seenHeaders.get("cookie")).toBe("cf_clearance=browser-cookie");
    expect(seenHeaders.get("user-agent")).toBe("Validated browser agent");
    expect(seenHeaders.get("origin")).toBe("https://tracker.test");
    expect(seenBody).toBe("login_username=user&login_password=password");
  });

  it("sends cookies only to the host or domain that set them", async () => {
    const seen: Array<[string, string | null]> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      seen.push([url.hostname, new Headers(init?.headers).get("cookie")]);
      if (url.pathname === "/login") {
        return new Response("ok", { status: 200, headers: [
          ["set-cookie", "host_only=a; Path=/"],
          ["set-cookie", "shared=b; Domain=.tracker.test; Path=/"],
          ["set-cookie", "foreign=c; Domain=other.test; Path=/"],
        ] });
      }
      return new Response("ok", { status: 200 });
    }));
    const session = new CookieSession();
    await session.get("https://www.tracker.test/login");
    await session.get("https://www.tracker.test/page");
    await session.get("https://feed.tracker.test/page");
    await session.get("https://other.test/page");
    expect(seen.slice(1)).toEqual([
      ["www.tracker.test", "host_only=a; shared=b"],
      ["feed.tracker.test", "shared=b"],
      ["other.test", null],
    ]);
  });

  it("refuses redirects to local addresses and form re-submission to another host", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/local") return new Response(null, { status: 302, headers: { location: "http://127.0.0.1:8080/admin" } });
      return new Response(null, { status: 307, headers: { location: "https://elsewhere.test/login" } });
    }));
    const session = new CookieSession();
    await expect(session.get("https://tracker.test/local")).rejects.toThrow("redirected to a blocked destination");
    await expect(session.postForm("https://tracker.test/login", { login_password: "secret" }))
      .rejects.toThrow("redirected a form submission to another host");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("stops reading oversized responses", async () => {
    const chunk = new Uint8Array(1_000_000);
    let sent = 0;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += 1;
        if (sent > 25) controller.close();
        else controller.enqueue(chunk);
      },
    }), { status: 200 })));
    await expect(new CookieSession().get("https://tracker.test/huge")).rejects.toThrow("larger than");
    expect(sent).toBeLessThan(25);
  });
});
