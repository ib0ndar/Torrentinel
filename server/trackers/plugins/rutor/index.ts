import type { TrackerPlugin } from "../../core/contracts.js";
import { hostMatchesManifest } from "../../core/contracts.js";
import { createRutorDirectMonitor } from "./direct.js";
import { rutorManifest } from "./manifest.js";
import { createRutorRuleDiscovery } from "./rules.js";
import { RutorTransport } from "./transport.js";

export function createRutorPlugin(transport = new RutorTransport()): TrackerPlugin {
  const normalizeUrl = (url: URL, baseUrl: string) => new URL(`${url.pathname}${url.search}`, baseUrl).toString();
  return {
    manifest: rutorManifest,
    matchesUrl: (url) => hostMatchesManifest(url.hostname, rutorManifest),
    normalizeUrl,
    direct: createRutorDirectMonitor(transport, normalizeUrl),
    rules: createRutorRuleDiscovery(transport),
    close: () => transport.close(),
  };
}
