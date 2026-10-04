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
  /** Why the password must be changed; absent when no change is required. */
  passwordChangeReason?: PasswordChangeReason;
  trackerMarkerStyle: TrackerMarkerStyle;
  language: "en" | "ru";
  paginationEnabled: boolean;
  pageSize: number;
  theme: ThemePreference;
}

// users.must_change_password stores why a change is required. Any non-zero value still means "must change",
// so older releases that read it as a boolean keep working against the same database.
export const PASSWORD_CHANGE = { none: 0, initial: 1, reset: 2, created: 3 } as const;
export type PasswordChangeReason = "initial" | "reset" | "created";
export function passwordChangeReason(value: number): PasswordChangeReason | undefined {
  if (!value) return undefined;
  return value === PASSWORD_CHANGE.reset ? "reset" : value === PASSWORD_CHANGE.created ? "created" : "initial";
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
