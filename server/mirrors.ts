import { hostMatchesManifest } from "./trackers/core/contracts.js";
import { trackerRegistry } from "./trackers/index.js";
import type { TrackerKey } from "./types.js";

/**
 * A personal mirror may only point at the tracker's own domains (on the default port) or at the
 * administrator's global mirror. Anything else would let an ordinary account make the server
 * request arbitrary addresses, including services on the local network.
 */
export function personalMirrorAllowed(trackerKey: TrackerKey, value: string, globalBaseUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return false;
  if (sameOrigin(url, globalBaseUrl)) return true;
  const manifest = trackerRegistry.get(trackerKey)?.manifest;
  return Boolean(manifest && url.port === "" && hostMatchesManifest(url.hostname, manifest));
}

/** The base URL tracker requests use: the personal override when it is still permitted, otherwise the global mirror. */
export function effectiveBaseUrl(trackerKey: TrackerKey, personalBaseUrl: string | null | undefined, globalBaseUrl: string): string {
  return personalBaseUrl && personalMirrorAllowed(trackerKey, personalBaseUrl, globalBaseUrl) ? personalBaseUrl : globalBaseUrl;
}

function sameOrigin(url: URL, other: string): boolean {
  try {
    return url.origin === new URL(other).origin;
  } catch {
    return false;
  }
}
