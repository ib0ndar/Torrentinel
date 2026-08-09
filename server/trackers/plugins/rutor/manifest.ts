import type { TrackerManifest } from "../../core/contracts.js";

export const rutorManifest: TrackerManifest = {
  key: "rutor",
  displayName: "Rutor",
  canonicalHosts: ["rutor.is", "rutor.info"],
  snapshotVersion: 1,
  capabilities: {
    authentication: "none",
    customMirrors: true,
    direct: true,
    rules: true,
    covers: true,
    ruleDiscovery: "recent-list",
  },
};
