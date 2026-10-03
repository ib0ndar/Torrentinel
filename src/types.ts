export type TrackerKey = "kinozal" | "rutor" | "rutracker";
export type SubscriptionType = "direct" | "rule";
export type TrackerMarkerStyle = "icons" | "abbreviations";
export const PAGE_SIZE_OPTIONS = [10, 20, 50, 100] as const;
export const THEME_PREFERENCES = ["auto", "sentinel", "graphite", "frost", "nebula", "ember", "daylight", "paper", "high-contrast"] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];

export interface User {
  id: string;
  username: string;
  isAdmin: boolean;
  mustChangePassword: boolean;
  trackerMarkerStyle: TrackerMarkerStyle;
  language: "en" | "ru";
  paginationEnabled: boolean;
  pageSize: number;
  theme: ThemePreference;
}

export interface Collection {
  id: string;
  name: string;
  subscriptionCount: number;
  unreadCount: number;
  /** Unread changes plus manual "Mark unread" reminders without unread changes; matches the Activity unread view. */
  activityCount: number;
  /** Subscriptions whose last check failed; matches the Errors filter. */
  errorCount: number;
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
  operation: "direct" | "feed-poll" | "rule-discovery" | "rule-enrichment";
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

export interface PagedResult { total: number; page: number; pageSize: number; pageCount: number }
export interface ObservationsResponse extends PagedResult { retentionHours: number; observations: TrackerObservation[]; outcomes: string[] }
export interface DeliveriesResponse extends PagedResult { retentionHours: number; telegramDeliveries: TelegramDelivery[] }
export interface NotificationQueueRow { id: string; username: string; subscriptionId: string; subscriptionName?: string | null; attempts: number; nextAttemptAt: string; lastError?: string | null; status: string }
export type Notify = (message: string, tone?: "good" | "bad") => void;
export type SubscriptionSummary = Omit<Subscription, "currentSnapshot">;

export interface ActivityEvent extends SubscriptionEvent {
  isUnread: boolean;
  subscription: Pick<Subscription, "id" | "type" | "label" | "directUrl" | "requiredTerms" | "ignoredTerms" | "trackerKeys">;
  collection: { id: string; name: string };
}
export interface ActivityReminder {
  subscription: ActivityEvent["subscription"];
  collection: ActivityEvent["collection"];
  lastChangedAt?: string | null;
}
