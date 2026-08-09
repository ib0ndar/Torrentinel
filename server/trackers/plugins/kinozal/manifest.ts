import type { TrackerManifest } from "../../core/contracts.js";

export const kinozalManifest: TrackerManifest = {
  key: "kinozal",
  displayName: "Kinozal",
  canonicalHosts: ["kinozal.tv", "kinozal.me", "kinozal.guru"],
  snapshotVersion: 2,
  capabilities: {
    authentication: "required",
    customMirrors: true,
    direct: true,
    rules: true,
    covers: true,
    ruleDiscovery: "recent-list",
  },
};
