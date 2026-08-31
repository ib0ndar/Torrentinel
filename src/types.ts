export type TrackerKey = "kinozal" | "rutor" | "rutracker";
export type SubscriptionType = "direct" | "rule";

export interface User {
  id: string;
  username: string;
  isAdmin: boolean;
  mustChangePassword: boolean;
}

export interface Collection {
  id: string;
  name: string;
  subscriptionCount: number;
  unreadCount: number;
  updatedCount: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface Subscription {
  id: string;
  collectionId: string;
  collectionName?: string;
  type: SubscriptionType;
  label: string;
  directUrl?: string | null;
  requiredTerms: string[];
  ignoredTerms: string[];
  trackerKeys: TrackerKey[];
  enabled: boolean;
  initialized: boolean;
  lastCheckedAt?: string | null;
  lastChangedAt?: string | null;
  lastError?: string | null;
  currentSnapshot?: {
    title?: string;
    url?: string;
    coverUrl?: string;
    magnet?: string;
    torrentUrl?: string;
  } | null;
  isUpdated: boolean;
  isUnread: boolean;
  unreadCount: number;
  eventCount: number;
  matchCount: number;
  createdAt: string;
}

export interface SubscriptionEvent {
  id: string;
  kind: string;
  summary: string;
  payload: Record<string, unknown> | null;
  createdAt: string;
  readAt?: string | null;
}

export interface RuleMatch {
  id: string;
  trackerKey: TrackerKey;
  externalId: string;
  title: string;
  url: string;
  magnet?: string | null;
  torrentUrl?: string | null;
  discoveredAt: string;
}

export interface Tracker {
  key: TrackerKey;
  displayName: string;
  hosts: string[];
  snapshotVersion: number;
  capabilities: {
    authentication: "none" | "optional" | "required";
    customMirrors: boolean;
    direct: boolean;
    rules: boolean;
    covers: boolean;
    ruleDiscovery?: "feed" | "recent-list" | "search";
  };
  baseUrl: string;
  globalBaseUrl: string;
  hasOverride: boolean;
  enabled: boolean;
  credentialsConfigured: boolean;
  username?: string;
}

export interface SchedulerStatus {
  running: boolean;
  lastStartedAt?: string;
  lastFinishedAt?: string;
  nextRunAt?: string;
  checked: number;
  changed: number;
  errors: number;
  trigger?: string;
}

export interface DiscoveryHealth {
  trackerKey: TrackerKey;
  fetchedAt: string;
  entryCount: number;
  overlapCount?: number;
  newEntryCount: number;
  oldestEntryAt?: string;
  newestEntryAt?: string;
  coverageMinutes?: number;
  coverageStatus: "baseline" | "continuous" | "gap" | "recovered" | string;
  lastContinuousAt?: string;
  unresolvedGapSince?: string;
  lastGapAt?: string;
  recoveredAt?: string;
  lastRecoveryAttemptAt?: string;
  pollingIntervalMinutes: number;
  safetyMargin?: number;
}

export interface TelegramStatus {
  configured: boolean;
  botUsername?: string;
  linked: boolean;
  telegramUsername?: string;
}

export interface AdminUser {
  id: string;
  username: string;
  isAdmin: boolean;
  disabled: boolean;
  mustChangePassword: boolean;
  collectionCount: number;
  subscriptionCount: number;
  createdAt: string;
}

export interface AdminMirror {
  trackerKey: TrackerKey;
  displayName: string;
  baseUrl: string;
  enabled: boolean;
  updatedAt: string;
}

export interface TrackerObservation {
  id: string;
  runId: string;
  subscriptionId?: string | null;
  subscriptionName?: string | null;
  username: string;
  trackerKey: TrackerKey;
  operation: "direct" | "rule-discovery" | "rule-enrichment";
  outcome: string;
  requestedUrl?: string | null;
  resolvedUrl?: string | null;
  httpStatus?: number | null;
  externalId?: string | null;
  title?: string | null;
  fingerprint?: string | null;
  hasCover?: boolean | null;
  hasMagnet?: boolean | null;
  hasTorrentFile?: boolean | null;
  releaseCount?: number | null;
  durationMs: number;
  errorCode?: string | null;
  errorMessage?: string | null;
  details: Record<string, unknown>;
  observedAt: string;
}

export interface DiagnosticRun {
  id: string;
  trigger: string;
  startedAt: string;
  finishedAt?: string | null;
  checked: number;
  changed: number;
  errors: number;
  durationMs?: number | null;
}

export interface TelegramDelivery {
  id: string;
  subscriptionId?: string | null;
  subscriptionName?: string | null;
  username: string;
  trackerKey?: TrackerKey | null;
  externalId?: string | null;
  title?: string | null;
  deliveryMethod: "none" | "text" | "photo-url" | "photo-upload" | "photo-cache";
  outcome: "delivered" | "failed" | "skipped";
  telegramMessageId?: number | null;
  errorMessage?: string | null;
  artworkErrorMessage?: string | null;
  durationMs: number;
  createdAt: string;
}

export interface DiagnosticsResponse {
  retentionHours: number;
  generatedAt: string;
  observations: TrackerObservation[];
  runs: DiagnosticRun[];
  telegramDeliveries: TelegramDelivery[];
}
