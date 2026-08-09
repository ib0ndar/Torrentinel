import type { TrackerManifest } from "../../core/contracts.js";

export const rutrackerManifest: TrackerManifest = {
  key: "rutracker",
  displayName: "RuTracker",
  canonicalHosts: ["rutracker.org", "rutracker.net"],
  snapshotVersion: 1,
  capabilities: {
    authentication: "optional",
    customMirrors: true,
    direct: true,
    rules: true,
    covers: true,
    ruleDiscovery: "feed",
  },
};
