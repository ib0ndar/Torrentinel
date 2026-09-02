import type { TrackerPlugin } from "../../core/contracts.js";
import { hostMatchesManifest } from "../../core/contracts.js";
import { IntegratedBrowserClient } from "../../core/transport/browser.js";
import { RutrackerDirectMonitor, type RutrackerDetailProvider } from "./direct.js";
import { rutrackerManifest } from "./manifest.js";
import { RutrackerRuleDiscovery } from "./rules.js";
import { RutrackerSearchRecovery } from "./search.js";

export function createRutrackerPlugin(detailProvider?: RutrackerDetailProvider): TrackerPlugin {
  const normalizeUrl = (url: URL, baseUrl: string) => {
    const path = url.pathname.startsWith("/forum/") ? url.pathname : `/forum${url.pathname}`;
    return new URL(`${path}${url.search}`, baseUrl).toString();
  };
  const sharedBrowser = detailProvider || new IntegratedBrowserClient();
  const direct = new RutrackerDirectMonitor(normalizeUrl, sharedBrowser);
  const searchRecovery = new RutrackerSearchRecovery(() => sharedBrowser);
  return {
    manifest: rutrackerManifest,
    matchesUrl: (url) => hostMatchesManifest(url.hostname, rutrackerManifest),
    normalizeUrl,
    direct,
    rules: new RutrackerRuleDiscovery(searchRecovery),
    close: async () => {
      await direct.close();
      await searchRecovery.close();
    },
  };
}
