import { connect, constants, type IncomingHttpHeaders } from "node:http2";

const MAX_REDIRECTS = 3;

export interface CoverAsset {
  bytes: ArrayBuffer;
  contentType: string;
}

export interface Http2CoverOptions {
  headers: Record<string, string>;
  maximumBytes: number;
  timeoutMs: number;
}

export type Http2CoverFetcher = (url: string, options: Http2CoverOptions) => Promise<CoverAsset>;

export const downloadCoverWithHttp2: Http2CoverFetcher = async (url, options) => (
  requestCover(url, options, 0)
);

async function requestCover(urlValue: string, options: Http2CoverOptions, redirectCount: number): Promise<CoverAsset> {
  const url = new URL(urlValue);
  if (url.protocol !== "https:") throw new Error("HTTPS/2 cover retry requires an HTTPS URL");

  const result = await new Promise<{
    status: number;
    headers: IncomingHttpHeaders;
    bytes: ArrayBuffer;
  }>((resolve, reject) => {
    const session = connect(url.origin);
    let settled = false;
    let responseHeaders: IncomingHttpHeaders = {};
    const chunks: Buffer[] = [];
    let receivedBytes = 0;

    const finish = (error?: Error, value?: { status: number; headers: IncomingHttpHeaders; bytes: ArrayBuffer }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        session.destroy();
        reject(error);
      } else {
        session.close();
        resolve(value!);
      }
    };
    const timer = setTimeout(() => finish(new Error("HTTPS/2 cover download timed out")), options.timeoutMs);
    session.once("error", (error) => finish(error));

    const request = session.request({
      [constants.HTTP2_HEADER_METHOD]: "GET",
      [constants.HTTP2_HEADER_PATH]: `${url.pathname}${url.search}`,
      ...options.headers,
    });
    request.once("response", (headers) => {
      responseHeaders = headers;
      const declaredLength = Number.parseInt(headerValue(headers["content-length"]) || "0", 10);
      if (declaredLength > options.maximumBytes) {
        request.close(constants.NGHTTP2_CANCEL);
        finish(new Error("cover exceeds Telegram's photo size limit"));
      }
    });
    request.on("data", (chunk: Buffer) => {
      receivedBytes += chunk.length;
      if (receivedBytes > options.maximumBytes) {
        request.close(constants.NGHTTP2_CANCEL);
        finish(new Error("cover exceeds Telegram's photo size limit"));
        return;
      }
      chunks.push(chunk);
    });
    request.once("end", () => {
      const status = Number(responseHeaders[constants.HTTP2_HEADER_STATUS] || 0);
      const buffer = Buffer.concat(chunks);
      finish(undefined, {
        status,
        headers: responseHeaders,
        bytes: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer,
      });
    });
    request.once("error", (error) => finish(error));
    request.end();
  });

  const location = headerValue(result.headers.location);
  if (result.status >= 300 && result.status < 400 && location) {
    if (redirectCount >= MAX_REDIRECTS) throw new Error("HTTPS/2 cover download exceeded the redirect limit");
    const redirectedUrl = new URL(location, url);
    if (redirectedUrl.protocol !== "https:") throw new Error("HTTPS/2 cover download refused an insecure redirect");
    return requestCover(redirectedUrl.toString(), options, redirectCount + 1);
  }
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`HTTPS/2 cover download failed with HTTP ${result.status || "unknown"}`);
  }
  const contentType = normalizedContentType(headerValue(result.headers["content-type"]));
  if (!contentType?.startsWith("image/")) throw new Error("HTTPS/2 cover URL did not return an image");
  return { bytes: result.bytes, contentType };
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function normalizedContentType(value: string | undefined): string | undefined {
  return value?.split(";", 1)[0].trim().toLocaleLowerCase("en-US") || undefined;
}
