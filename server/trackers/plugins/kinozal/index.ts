import type { TrackerPlugin } from "../../core/contracts.js";
import { hostMatchesManifest, urlOnMirror } from "../../core/contracts.js";
import { KinozalSessionManager, type KinozalPageSession } from "./auth.js";
import { createKinozalDirectMonitor } from "./direct.js";
import { kinozalManifest } from "./manifest.js";
import { createKinozalRuleDiscovery } from "./rules.js";

export function createKinozalPlugin(session: KinozalPageSession = new KinozalSessionManager()): TrackerPlugin {
  const normalizeUrl = (url: URL, baseUrl: string) => urlOnMirror(url, baseUrl);
  return {
    manifest: kinozalManifest,
    matchesUrl: (url) => hostMatchesManifest(url.hostname, kinozalManifest),
    normalizeUrl,
    direct: createKinozalDirectMonitor(session, normalizeUrl),
    rules: createKinozalRuleDiscovery(session),
    close: async () => session.close?.(),
  };
}
