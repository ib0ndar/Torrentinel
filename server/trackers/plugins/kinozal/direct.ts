import type { DirectMonitor } from "../../core/contracts.js";
import { fingerprintRelease } from "../../core/parsing.js";
import type { KinozalSessionManager } from "./auth.js";
import { parseKinozalDirect } from "./parser.js";

export function createKinozalDirectMonitor(session: KinozalSessionManager, normalizeUrl: (url: URL, baseUrl: string) => string): DirectMonitor {
  return {
    async fetchSnapshot(url, context) {
      const normalized = normalizeUrl(new URL(url), context.baseUrl);
      const result = await session.get(normalized, context);
      const release = parseKinozalDirect(result.body, normalized);
      return { ...release, fingerprint: fingerprintRelease(release) };
    },
  };
}
