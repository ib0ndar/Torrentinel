import { config } from "../../../config.js";
import { assertPublicHttpUrl } from "../../../egress.js";
import { TrackerError, type TrackerErrorCode } from "../errors.js";

const MAX_RESPONSE_BYTES = 20_000_000;

export interface HttpResult {
  url: string;
  status: number;
  body: string;
  headers: Headers;
}

export interface SeedCookie {
  name: string;
  value: string;
  /** Cookie domain as reported by the browser; a leading dot applies it to subdomains. */
  domain?: string;
}

interface StoredCookie {
  name: string;
  value: string;
  domain: string;
  hostOnly: boolean;
  secure: boolean;
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
  private readonly cookies = new Map<string, StoredCookie>();
  private userAgent = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131 Safari/537.36 Torrentinel/0.1";
  authenticated = false;

  clear(): void {
    this.cookies.clear();
    this.authenticated = false;
  }

  /** Replaces the jar with browser cookies; cookies without a domain belong to the host of sourceUrl. */
  seedCookies(cookies: SeedCookie[], userAgent?: string, sourceUrl?: string): void {
    this.cookies.clear();
    const sourceHost = sourceUrl ? new URL(sourceUrl).hostname.toLocaleLowerCase("en-US") : undefined;
    for (const cookie of cookies) {
      if (!cookie.name || !cookie.value) continue;
      const domain = cookie.domain?.toLocaleLowerCase("en-US");
      if (domain) this.store({ name: cookie.name, value: cookie.value, domain: domain.replace(/^\./u, ""), hostOnly: !domain.startsWith("."), secure: false });
      else if (sourceHost) this.store({ name: cookie.name, value: cookie.value, domain: sourceHost, hostOnly: true, secure: false });
    }
    if (userAgent) this.userAgent = userAgent;
  }

  async get(url: string, signal?: AbortSignal): Promise<HttpResult> {
    return this.request(url, { method: "GET", signal });
  }

  async postForm(
    url: string,
    values: Record<string, string>,
    signal?: AbortSignal,
    additionalHeaders?: RequestInit["headers"],
  ): Promise<HttpResult> {
    const headers = new Headers(additionalHeaders);
    headers.set("content-type", "application/x-www-form-urlencoded");
    return this.request(url, {
      method: "POST",
      headers,
      body: new URLSearchParams(values).toString(),
      signal,
    });
  }

  async request(url: string, init: RequestInit): Promise<HttpResult> {
    let currentUrl = new URL(url);
    let method = init.method || "GET";
    let body = init.body;
    let requestHeaders = init.headers;

    for (let redirectCount = 0; redirectCount < 6; redirectCount += 1) {
      const timeout = AbortSignal.timeout(config.requestTimeoutMs);
      const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
      const headers = new Headers(requestHeaders);
      headers.set("user-agent", this.userAgent);
      headers.set("accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8");
      headers.set("accept-language", "en-US,en;q=0.8,ru;q=0.7");
      const cookie = this.cookieHeader(currentUrl);
      if (cookie) headers.set("cookie", cookie);

      let response: Response;
      try {
        response = await fetch(currentUrl, { ...init, method, body, headers, signal, redirect: "manual" });
      } catch (error) {
        throw new TrackerHttpError(`Request to ${currentUrl.host} failed: ${errorMessage(error)}`, undefined, error, currentUrl.toString());
      }

      this.captureCookies(response.headers, currentUrl);
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        await response.body?.cancel().catch(() => undefined);
        if (!location) throw new TrackerHttpError("Tracker returned a redirect without a location", response.status, undefined, currentUrl.toString());
        const nextUrl = new URL(location, currentUrl);
        if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
          method = "GET";
          body = undefined;
        }
        if (nextUrl.hostname !== currentUrl.hostname) {
          await this.checkCrossHostRedirect(nextUrl, method, currentUrl);
          // Origin, referer and similar headers were meant for the tracker that was asked.
          requestHeaders = undefined;
        }
        currentUrl = nextUrl;
        continue;
      }

      const bytes = await readLimited(response, currentUrl);
      const decodedBody = decodeBody(bytes, response.headers.get("content-type"));
      if (!response.ok) {
        throw new TrackerHttpError(`${currentUrl.host} returned HTTP ${response.status}`, response.status, undefined, currentUrl.toString());
      }
      return { url: currentUrl.toString(), status: response.status, body: decodedBody, headers: response.headers };
    }

    throw new TrackerHttpError("Too many tracker redirects", undefined, undefined, currentUrl.toString());
  }

  private async checkCrossHostRedirect(nextUrl: URL, method: string, from: URL): Promise<void> {
    if (method !== "GET" && method !== "HEAD") {
      throw new TrackerHttpError(`${from.host} redirected a form submission to another host`, undefined, undefined, from.toString());
    }
    try {
      await assertPublicHttpUrl(nextUrl);
    } catch (error) {
      throw new TrackerHttpError(`${from.host} redirected to a blocked destination: ${errorMessage(error)}`, undefined, error, from.toString());
    }
  }

  private cookieHeader(url: URL): string {
    const host = url.hostname.toLocaleLowerCase("en-US");
    return [...this.cookies.values()]
      .filter((cookie) => domainMatches(host, cookie) && (!cookie.secure || url.protocol === "https:"))
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join("; ");
  }

  private captureCookies(headers: Headers, url: URL): void {
    const host = url.hostname.toLocaleLowerCase("en-US");
    const values = typeof headers.getSetCookie === "function"
      ? headers.getSetCookie()
      : headers.get("set-cookie")?.split(/,(?=[^;,]+=[^;,]+)/g) || [];
    for (const value of values) {
      const [pair, ...attributeParts] = value.split(";");
      const separator = pair.indexOf("=");
      if (separator < 1) continue;
      const name = pair.slice(0, separator).trim();
      const cookieValue = pair.slice(separator + 1).trim();
      const attributes = new Map(attributeParts.map((part) => {
        const index = part.indexOf("=");
        return index < 0
          ? [part.trim().toLocaleLowerCase("en-US"), ""]
          : [part.slice(0, index).trim().toLocaleLowerCase("en-US"), part.slice(index + 1).trim()];
      }));
      const declaredDomain = attributes.get("domain")?.replace(/^\./u, "").toLocaleLowerCase("en-US");
      // A host may only set cookies for itself or a parent domain it belongs to.
      if (declaredDomain && host !== declaredDomain && !host.endsWith(`.${declaredDomain}`)) continue;
      const cookie: StoredCookie = {
        name,
        value: cookieValue,
        domain: declaredDomain || host,
        hostOnly: !declaredDomain,
        secure: attributes.has("secure"),
      };
      const maxAge = Number.parseInt(attributes.get("max-age") ?? "", 10);
      const expires = Date.parse(attributes.get("expires") ?? "");
      const expired = (Number.isFinite(maxAge) && maxAge <= 0) || (!Number.isFinite(maxAge) && Number.isFinite(expires) && expires <= Date.now());
      if (!cookieValue || expired) this.cookies.delete(cookieKey(cookie));
      else this.store(cookie);
    }
  }

  private store(cookie: StoredCookie): void {
    this.cookies.set(cookieKey(cookie), cookie);
  }
}

function cookieKey(cookie: Pick<StoredCookie, "domain" | "name">): string {
  return `${cookie.domain}\n${cookie.name}`;
}

function domainMatches(host: string, cookie: StoredCookie): boolean {
  return host === cookie.domain || (!cookie.hostOnly && host.endsWith(`.${cookie.domain}`));
}

async function readLimited(response: Response, url: URL): Promise<Uint8Array> {
  const tooLarge = () => new TrackerHttpError(`${url.host} returned a response larger than ${MAX_RESPONSE_BYTES} bytes`, undefined, undefined, url.toString());
  if (Number.parseInt(response.headers.get("content-length") || "0", 10) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw tooLarge();
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
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
