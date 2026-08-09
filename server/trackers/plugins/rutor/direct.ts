import type { DirectMonitor } from "../../core/contracts.js";
import { fingerprintRelease } from "../../core/parsing.js";
import { parseRutorDirect } from "./parser.js";
import type { RutorTransport } from "./transport.js";

export function createRutorDirectMonitor(transport: RutorTransport, normalizeUrl: (url: URL, baseUrl: string) => string): DirectMonitor {
  return {
    async fetchSnapshot(url, context) {
      const normalized = normalizeUrl(new URL(url), context.baseUrl);
      const result = await transport.get(normalized, context);
      const release = parseRutorDirect(result.body, normalized);
      return { ...release, fingerprint: fingerprintRelease(release) };
    },
  };
}
