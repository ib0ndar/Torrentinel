import type { DirectSnapshot, Release, TrackerKey } from "../../types.js";

export type TrackerAuthMode = "none" | "optional" | "required";
export type RuleDiscoveryMode = "feed" | "recent-list" | "search";

export interface TrackerContext {
  userId?: string;
  baseUrl: string;
  username?: string;
  password?: string;
  signal?: AbortSignal;
}

export interface TrackerManifest {
  key: TrackerKey;
  displayName: string;
  canonicalHosts: readonly string[];
  snapshotVersion: number;
  capabilities: {
    authentication: TrackerAuthMode;
    customMirrors: boolean;
    direct: boolean;
    rules: boolean;
    covers: boolean;
    ruleDiscovery?: RuleDiscoveryMode;
  };
  ruleDiscoveryRevision?: string;
}

export interface DiscoveryCoverage {
  source: RuleDiscoveryMode;
  complete: boolean;
  oldestObservedAt?: string;
}

export interface DiscoveryBatch {
  releases: Release[];
  coverage: DiscoveryCoverage;
  cursor?: string;
  sourceUrl?: string;
}

export interface RuleDiscoveryQuery {
  requiredTerms: readonly string[];
}

export interface DirectMonitor {
  fetchSnapshot(url: string, context: TrackerContext): Promise<DirectSnapshot>;
}

export interface RuleDiscoveryProvider {
  discover(context: TrackerContext, query?: RuleDiscoveryQuery): Promise<DiscoveryBatch>;
  recover?(context: TrackerContext, query: RuleDiscoveryQuery, since: string): Promise<DiscoveryBatch>;
}

export interface TrackerPlugin {
  manifest: TrackerManifest;
  matchesUrl(url: URL): boolean;
  normalizeUrl(url: URL, baseUrl: string): string;
  direct?: DirectMonitor;
  rules?: RuleDiscoveryProvider;
  close?(): Promise<void>;
}

export function hostMatchesManifest(hostname: string, manifest: TrackerManifest): boolean {
  const normalized = hostname.toLocaleLowerCase("en-US");
  return manifest.canonicalHosts.some((host) => normalized === host || normalized.endsWith(`.${host}`));
}
