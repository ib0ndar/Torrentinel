import { TrackerPluginRegistry } from "./core/registry.js";
import { createKinozalPlugin } from "./plugins/kinozal/index.js";
import { createRutorPlugin } from "./plugins/rutor/index.js";
import { createRutrackerPlugin } from "./plugins/rutracker/index.js";

export const trackerRegistry = new TrackerPluginRegistry([
  createKinozalPlugin(),
  createRutorPlugin(),
  createRutrackerPlugin(),
]);

export const adapterForUrl = (url: string) => trackerRegistry.forUrl(url);

export function listTrackers() {
  return trackerRegistry.manifests().map((manifest) => ({
    key: manifest.key,
    displayName: manifest.displayName,
    hosts: [...manifest.canonicalHosts],
    snapshotVersion: manifest.snapshotVersion,
    capabilities: manifest.capabilities,
  }));
}

export async function closeTrackerAdapters(): Promise<void> {
  await trackerRegistry.close();
}
