import type { TrackerKey } from "../../types.js";
import type { TrackerManifest, TrackerPlugin } from "./contracts.js";

export class TrackerPluginRegistry {
  private readonly plugins = new Map<TrackerKey, TrackerPlugin>();

  constructor(values: TrackerPlugin[]) {
    for (const plugin of values) {
      validatePlugin(plugin);
      if (this.plugins.has(plugin.manifest.key)) {
        throw new Error(`Duplicate tracker plugin: ${plugin.manifest.key}`);
      }
      this.plugins.set(plugin.manifest.key, plugin);
    }
  }

  get(key: TrackerKey): TrackerPlugin | undefined {
    return this.plugins.get(key);
  }

  forUrl(value: string): TrackerPlugin | undefined {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return undefined;
    }
    return [...this.plugins.values()].find((plugin) => plugin.matchesUrl(url));
  }

  manifests(): TrackerManifest[] {
    return [...this.plugins.values()].map((plugin) => plugin.manifest);
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.plugins.values()].map((plugin) => plugin.close?.()));
  }
}

function validatePlugin(plugin: TrackerPlugin): void {
  const { manifest } = plugin;
  if (!manifest.key || !manifest.displayName || manifest.canonicalHosts.length === 0 || !Number.isInteger(manifest.snapshotVersion) || manifest.snapshotVersion < 1) {
    throw new Error("Tracker plugins require a key, display name, snapshot version, and at least one canonical host");
  }
  if (manifest.capabilities.direct !== Boolean(plugin.direct)) {
    throw new Error(`${manifest.key} direct capability does not match its provider`);
  }
  if (manifest.capabilities.rules !== Boolean(plugin.rules)) {
    throw new Error(`${manifest.key} rule capability does not match its provider`);
  }
  if (manifest.capabilities.rules && !manifest.capabilities.ruleDiscovery) {
    throw new Error(`${manifest.key} must declare a rule discovery mode`);
  }
}
