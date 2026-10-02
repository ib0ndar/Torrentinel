export const TRACKER_KEYS = ["kinozal", "rutor", "rutracker"] as const;
export type TrackerKey = (typeof TRACKER_KEYS)[number];
export type SubscriptionType = "direct" | "rule";
export type TrackerMarkerStyle = "icons" | "abbreviations";
export const THEME_PREFERENCES = ["auto", "sentinel", "graphite", "frost", "nebula", "ember", "daylight", "paper", "high-contrast"] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];
export function themePreference(value: unknown): ThemePreference {
  return THEME_PREFERENCES.includes(value as ThemePreference) ? value as ThemePreference : "sentinel";
}

export interface AuthUser {
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
