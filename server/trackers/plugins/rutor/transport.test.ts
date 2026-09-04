import { describe, expect, it, vi } from "vitest";
import { TrackerError } from "../../core/errors.js";
import type { BrowserPage } from "../../core/transport/browser.js";
import type { HttpResult } from "../../core/transport/http.js";
import { RutorTransport } from "./transport.js";

const context = { baseUrl: "https://rutor.is" };
const requestedUrl = "https://rutor.is/torrent/472";

describe("Rutor transport", () => {
  it("keeps successful requests on the HTTP fast path", async () => {
    const response = httpResult("<html><title>Release</title></html>");
    const http = {
      get: vi.fn(async () => response),
      seedCookies: vi.fn(),
    };
    const browserFactory = vi.fn();
    const transport = new RutorTransport(() => http, browserFactory);

    await expect(transport.get(requestedUrl, context)).resolves.toBe(response);

    expect(http.get).toHaveBeenCalledOnce();
    expect(browserFactory).not.toHaveBeenCalled();
  });

  it("falls back to a persistent browser on HTTP challenges and reuses its clearance", async () => {
    const clearedPage: BrowserPage = {
      body: "<html><title>Browser-cleared release</title></html>",
      status: 200,
      url: requestedUrl,
      cookies: [{ name: "cf_clearance", value: "fixture-clearance" }],
      userAgent: "Fixture browser agent",
    };
    const fastResponse = httpResult("<html><title>HTTP with reused clearance</title></html>");
    const http = {
      get: vi.fn()
        .mockRejectedValueOnce(new TrackerError("challenge", "HTTP 403", { trackerKey: "rutor", status: 403 }))
        .mockResolvedValueOnce(fastResponse),
      seedCookies: vi.fn(),
    };
    const browser = {
      get: vi.fn(async () => clearedPage),
      close: vi.fn(async () => undefined),
    };
    const browserFactory = vi.fn(() => browser);
    const transport = new RutorTransport(() => http, browserFactory);

    await expect(transport.get(requestedUrl, context)).resolves.toMatchObject({
      body: clearedPage.body,
      status: 200,
      url: requestedUrl,
    });
    await expect(transport.get(requestedUrl, context)).resolves.toBe(fastResponse);

    expect(browserFactory).toHaveBeenCalledOnce();
    expect(browserFactory).toHaveBeenCalledWith("torrentinel-rutor-rutor.is");
    expect(browser.get).toHaveBeenCalledOnce();
    expect(http.seedCookies).toHaveBeenCalledWith(clearedPage.cookies, clearedPage.userAgent);
    await transport.close();
    expect(browser.close).toHaveBeenCalledOnce();
  });

  it("also falls back when a nominally successful HTTP response contains a challenge", async () => {
    const http = {
      get: vi.fn(async () => httpResult("<html><title>Just a moment...</title><div class='cf-turnstile'></div></html>")),
      seedCookies: vi.fn(),
    };
    const browser = {
      get: vi.fn(async (): Promise<BrowserPage> => ({
        body: "<html><title>Cleared</title></html>",
        status: 200,
        url: requestedUrl,
        cookies: [],
        userAgent: "Fixture browser agent",
      })),
    };
    const transport = new RutorTransport(() => http, () => browser);

    await expect(transport.get(requestedUrl, context)).resolves.toMatchObject({
      body: "<html><title>Cleared</title></html>",
    });
    expect(browser.get).toHaveBeenCalledOnce();
    expect(http.seedCookies).toHaveBeenCalledWith([], "Fixture browser agent");
  });

  it("does not start a browser for non-challenge failures", async () => {
    const failure = new TrackerError("network", "Connection failed", { trackerKey: "rutor" });
    const http = {
      get: vi.fn(async () => Promise.reject(failure)),
      seedCookies: vi.fn(),
    };
    const browserFactory = vi.fn();
    const transport = new RutorTransport(() => http, browserFactory);

    await expect(transport.get(requestedUrl, context)).rejects.toBe(failure);
    expect(browserFactory).not.toHaveBeenCalled();
  });
});

function httpResult(body: string): HttpResult {
  return {
    body,
    status: 200,
    url: requestedUrl,
    headers: new Headers(),
  };
}
