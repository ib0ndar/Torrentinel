import {
  downloadCoverWithHttp2,
  type CoverAsset,
  type Http2CoverFetcher,
} from "./cover-http2.js";

export const MAX_COVER_BYTES = 10_000_000;
export const COVER_USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138 Safari/537.36";

export interface CoverRetrieval {
  asset: CoverAsset;
  fallbackErrors?: string;
}

export interface CoverRetriever {
  retrieve(coverUrl: string, releaseUrl: string): Promise<CoverRetrieval>;
}

export class NetworkCoverRetriever implements CoverRetriever {
  constructor(
    private readonly mediaFetcher: typeof fetch = fetch,
    private readonly http2MediaFetcher: Http2CoverFetcher = downloadCoverWithHttp2,
  ) {}

  async retrieve(coverUrl: string, releaseUrl: string): Promise<CoverRetrieval> {
    const headers = {
      accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
      referer: releaseUrl,
      "user-agent": COVER_USER_AGENT,
    };
    try {
      const response = await this.mediaFetcher(coverUrl, {
        headers,
        signal: AbortSignal.timeout(20_000),
      });
      return { asset: await coverAssetFromResponse(response) };
    } catch (error) {
      const standardFetchError = coverErrorMessage(error);
      try {
        const asset = await this.http2MediaFetcher(coverUrl, {
          headers,
          maximumBytes: MAX_COVER_BYTES,
          timeoutMs: 20_000,
        });
        return { asset, fallbackErrors: `standard HTTPS fetch: ${standardFetchError}` };
      } catch (http2Error) {
        const { referer: _referer, ...headersWithoutReferer } = headers;
        try {
          const asset = await this.http2MediaFetcher(coverUrl, {
            headers: headersWithoutReferer,
            maximumBytes: MAX_COVER_BYTES,
            timeoutMs: 20_000,
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
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > MAX_COVER_BYTES) throw new Error("cover exceeds Telegram's photo size limit");
  return { bytes, contentType };
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
