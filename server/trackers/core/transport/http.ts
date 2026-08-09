import { config } from "../../../config.js";
import { TrackerError, type TrackerErrorCode } from "../errors.js";

export interface HttpResult {
  url: string;
  status: number;
  body: string;
  headers: Headers;
}

export class TrackerHttpError extends TrackerError {
  constructor(message: string, status?: number, cause?: unknown, url?: string) {
    super(httpErrorCode(status), message, {
      status,
      url,
      cause,
      retryable: status === undefined || status === 403 || status === 408 || status === 429 || (status >= 500 && status <= 599),
    });
    this.name = "TrackerHttpError";
  }
}

export class CookieSession {
  private readonly cookies = new Map<string, string>();
  authenticated = false;

  clear(): void {
    this.cookies.clear();
    this.authenticated = false;
  }

  async get(url: string, signal?: AbortSignal): Promise<HttpResult> {
    return this.request(url, { method: "GET", signal });
  }

  async postForm(url: string, values: Record<string, string>, signal?: AbortSignal): Promise<HttpResult> {
    return this.request(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(values).toString(),
      signal,
    });
  }

  async request(url: string, init: RequestInit): Promise<HttpResult> {
    let currentUrl = url;
    let method = init.method || "GET";
    let body = init.body;

    for (let redirectCount = 0; redirectCount < 6; redirectCount += 1) {
      const timeout = AbortSignal.timeout(config.requestTimeoutMs);
      const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
      const headers = new Headers(init.headers);
      headers.set("user-agent", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131 Safari/537.36 Torrentinel/0.1");
      headers.set("accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8");
      headers.set("accept-language", "en-US,en;q=0.8,ru;q=0.7");
      if (this.cookies.size > 0) {
        headers.set("cookie", [...this.cookies.entries()].map(([key, value]) => `${key}=${value}`).join("; "));
      }

      let response: Response;
      try {
        response = await fetch(currentUrl, { ...init, method, body, headers, signal, redirect: "manual" });
      } catch (error) {
        throw new TrackerHttpError(`Request to ${new URL(currentUrl).host} failed: ${errorMessage(error)}`, undefined, error, currentUrl);
      }

      this.captureCookies(response.headers);
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) throw new TrackerHttpError("Tracker returned a redirect without a location", response.status, undefined, currentUrl);
        currentUrl = new URL(location, currentUrl).toString();
        if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
          method = "GET";
          body = undefined;
        }
        continue;
      }

      const bytes = new Uint8Array(await response.arrayBuffer());
      const decodedBody = decodeBody(bytes, response.headers.get("content-type"));
      if (!response.ok) {
        throw new TrackerHttpError(`${new URL(currentUrl).host} returned HTTP ${response.status}`, response.status, undefined, currentUrl);
      }
      return { url: currentUrl, status: response.status, body: decodedBody, headers: response.headers };
    }

    throw new TrackerHttpError("Too many tracker redirects", undefined, undefined, currentUrl);
  }

  private captureCookies(headers: Headers): void {
    const values = typeof headers.getSetCookie === "function"
      ? headers.getSetCookie()
      : headers.get("set-cookie")?.split(/,(?=[^;,]+=[^;,]+)/g) || [];
    for (const value of values) {
      const pair = value.split(";", 1)[0];
      const separator = pair.indexOf("=");
      if (separator < 1) continue;
      const key = pair.slice(0, separator).trim();
      const cookieValue = pair.slice(separator + 1).trim();
      if (cookieValue) this.cookies.set(key, cookieValue);
      else this.cookies.delete(key);
    }
  }
}

function httpErrorCode(status?: number): TrackerErrorCode {
  if (status === 401) return "authentication";
  if (status === 403) return "challenge";
  if (status === 404 || status === 410) return "missing";
  if (status === 408 || status === 429) return "rate-limit";
  if (status !== undefined && status >= 500) return "temporary";
  return status === undefined ? "network" : "http";
}

function decodeBody(bytes: Uint8Array, contentType: string | null): string {
  const head = new TextDecoder("ascii").decode(bytes.slice(0, 2048));
  const declared = contentType?.match(/charset\s*=\s*([^;\s]+)/i)?.[1]
    || head.match(/charset\s*=\s*["']?([^\s"'/>;]+)/i)?.[1]
    || "utf-8";
  try {
    return new TextDecoder(declared.replace(/["']/g, "")).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
