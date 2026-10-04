import { Agent, fetch as undiciFetch } from "undici";
import {
  downloadCoverWithHttp2,
  type CoverAsset,
  type Http2CoverFetcher,
} from "./cover-http2.js";
import { assertPublicHttpUrl, bareHostname, publicOnlyLookup } from "./egress.js";

export const MAX_COVER_BYTES = 10_000_000;
export const COVER_USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138 Safari/537.36";
const MAX_COVER_REDIRECTS = 3;

export interface CoverRequestInit {
  headers: Record<string, string>;
  signal: AbortSignal;
  /** Host of the release page; only this host may resolve to a local address (an administrator's LAN mirror). */
  trustedHostname?: string;
}

export type CoverFetcher = (url: string, init: CoverRequestInit) => Promise<Response>;

const publicDispatcher = new Agent({ connect: { lookup: publicOnlyLookup } });

/**
 * Cover URLs come from tracker posts written by uploaders, so every hop that leaves the
 * release page's host must reach the public internet. Redirects are followed here so each
 * target is checked, and the dispatcher re-checks the address it actually connects to.
 */
export const fetchCover: CoverFetcher = async (url, init) => {
  let current = new URL(url);
  for (let redirects = 0; ; redirects += 1) {
    const trusted = Boolean(init.trustedHostname) && bareHostname(current) === init.trustedHostname;
    if (current.protocol !== "http:" && current.protocol !== "https:") throw new Error(`cover URL uses unsupported scheme ${current.protocol}`);
    if (!trusted) await assertPublicHttpUrl(current);
    const response = await undiciFetch(current, {
      headers: init.headers,
      signal: init.signal,
      redirect: "manual",
      ...(trusted ? {} : { dispatcher: publicDispatcher }),
    });
    const location = response.status >= 300 && response.status < 400 ? response.headers.get("location") : null;
    if (!location) return response as unknown as Response;
    await response.body?.cancel().catch(() => undefined);
    if (redirects >= MAX_COVER_REDIRECTS) throw new Error("cover download exceeded the redirect limit");
    current = new URL(location, current);
  }
};

export interface CoverRetrieval {
  asset: CoverAsset;
  fallbackErrors?: string;
}

export interface CoverRetriever {
  retrieve(coverUrl: string, releaseUrl: string): Promise<CoverRetrieval>;
}

export class NetworkCoverRetriever implements CoverRetriever {
  constructor(
    private readonly mediaFetcher: CoverFetcher = fetchCover,
    private readonly http2MediaFetcher: Http2CoverFetcher = downloadCoverWithHttp2,
  ) {}

  async retrieve(coverUrl: string, releaseUrl: string): Promise<CoverRetrieval> {
    const headers = {
      accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
      referer: releaseUrl,
      "user-agent": COVER_USER_AGENT,
    };
    const trustedHostname = hostnameOf(releaseUrl);
    try {
      const response = await this.mediaFetcher(coverUrl, {
        headers,
        signal: AbortSignal.timeout(20_000),
        trustedHostname,
      });
      return { asset: await coverAssetFromResponse(response) };
    } catch (error) {
      const standardFetchError = coverErrorMessage(error);
      try {
        const asset = await this.http2MediaFetcher(coverUrl, {
          headers,
          maximumBytes: MAX_COVER_BYTES,
          timeoutMs: 20_000,
          trustedHostname,
        });
        return { asset, fallbackErrors: `standard HTTPS fetch: ${standardFetchError}` };
      } catch (http2Error) {
        const { referer: _referer, ...headersWithoutReferer } = headers;
        try {
          const asset = await this.http2MediaFetcher(coverUrl, {
            headers: headersWithoutReferer,
            maximumBytes: MAX_COVER_BYTES,
            timeoutMs: 20_000,
            trustedHostname,
          });
          return {
            asset,
            fallbackErrors: [
              `standard HTTPS fetch: ${standardFetchError}`,
              `HTTPS/2 retry with referer: ${coverErrorMessage(http2Error)}`,
            ].join("; "),
          };
        } catch (http2WithoutRefererError) {
          throw new Error([
            `standard HTTPS fetch: ${standardFetchError}`,
            `HTTPS/2 retry with referer: ${coverErrorMessage(http2Error)}`,
            `HTTPS/2 retry without referer: ${coverErrorMessage(http2WithoutRefererError)}`,
          ].join("; "));
        }
      }
    }
  }
}

export async function coverAssetFromResponse(response: Response): Promise<CoverAsset> {
  if (!response.ok) throw new Error(`cover download failed with HTTP ${response.status}`);
  const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLocaleLowerCase("en-US");
  if (!contentType?.startsWith("image/")) throw new Error("cover URL did not return an image");
  const declaredLength = Number.parseInt(response.headers.get("content-length") || "0", 10);
  if (declaredLength > MAX_COVER_BYTES) throw new Error("cover exceeds Telegram's photo size limit");
  return { bytes: await readLimited(response, MAX_COVER_BYTES), contentType };
}

async function readLimited(response: Response, maximumBytes: number): Promise<ArrayBuffer> {
  if (!response.body) return new ArrayBuffer(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maximumBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error("cover exceeds Telegram's photo size limit");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes.buffer;
}

function hostnameOf(value: string): string | undefined {
  try {
    return bareHostname(new URL(value));
  } catch {
    return undefined;
  }
}

export function coverErrorMessage(error: unknown): string {
  const messages: string[] = [];
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") {
      if (value !== undefined && value !== null) messages.push(String(value));
      return;
    }
    const record = value as { message?: unknown; code?: unknown; cause?: unknown; errors?: unknown };
    const message = typeof record.message === "string" ? record.message.trim() : "";
    const code = typeof record.code === "string" ? record.code : "";
    if (message || code) messages.push(message && code && !message.includes(code) ? `${message} [${code}]` : message || code);
    if (Array.isArray(record.errors)) record.errors.forEach(visit);
    visit(record.cause);
  };
  visit(error);
  const uniqueMessages = [...new Set(messages.filter(Boolean))];
  return uniqueMessages.join(" -> ") || (error instanceof Error ? error.name : String(error));
}
