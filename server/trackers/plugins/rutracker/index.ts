import type { TrackerPlugin } from "../../core/contracts.js";
import { hostMatchesManifest } from "../../core/contracts.js";
import { RutrackerDirectMonitor, type RutrackerDetailProvider } from "./direct.js";
import { rutrackerManifest } from "./manifest.js";
import { RutrackerRuleDiscovery } from "./rules.js";

export function createRutrackerPlugin(detailProvider?: RutrackerDetailProvider): TrackerPlugin {
  const normalizeUrl = (url: URL, baseUrl: string) => {
    const path = url.pathname.startsWith("/forum/") ? url.pathname : `/forum${url.pathname}`;
    return new URL(`${path}${url.search}`, baseUrl).toString();
  };
  const direct = new RutrackerDirectMonitor(normalizeUrl, detailProvider);
  return {
    manifest: rutrackerManifest,
    matchesUrl: (url) => hostMatchesManifest(url.hostname, rutrackerManifest),
    normalizeUrl,
    direct,
    rules: new RutrackerRuleDiscovery(),
    close: async () => {
      await direct.close();
    },
  };
}
