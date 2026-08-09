export const TRACKER_KEYS = ["kinozal", "rutor", "rutracker"] as const;
export type TrackerKey = (typeof TRACKER_KEYS)[number];
export type SubscriptionType = "direct" | "rule";

export interface AuthUser {
  id: string;
  username: string;
  isAdmin: boolean;
  mustChangePassword: boolean;
}

export interface Release {
  trackerKey: TrackerKey;
  externalId: string;
  title: string;
  url: string;
  coverUrl?: string;
  magnet?: string;
  torrentUrl?: string;
  publishedAt?: string;
  metadata?: Record<string, string | number | boolean | null>;
}

export interface DirectSnapshot extends Release {
  fingerprint: string;
}
