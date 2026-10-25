import { magnetInfoHash } from "./trackers/core/parsing.js";
import type { Release } from "./types.js";

/**
 * A page loaded longer ago than this is loaded again even when the feed shows no change. Edits that
 * keep the torrent (a new title or cover from a moderator) and deleted topics never reach the feed.
 */
export const FEED_ASSIST_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

/** Allowance between the tracker's clock, which dates feed entries, and this server's, which dates page loads. */
export const FEED_ASSIST_CLOCK_SKEW_MS = 10 * 60 * 1_000;

export interface FeedAssistInput {
  /** When the topic page was last loaded successfully, by this server's clock. */
  verifiedAt: string | null;
  /** The magnet link saved from that page. */
  storedMagnet?: string;
  /** From when the feed has been followed without a gap, by the tracker's clock. */
  continuousSince?: string;
  /** The topic's entry in the feed buffer, if it has one. */
  entry?: Pick<Release, "publishedAt" | "magnet">;
  now?: number;
}

/**
 * Whether the feed shows that a watched topic has not changed since its page was last loaded, so a
 * scheduled check can skip loading the page again. The feed lists every topic whose torrent is
 * replaced, so a topic it has not listed since then still has the torrent saved from its page.
 * Any doubt answers no, and the page is loaded as before.
 */
export function feedShowsNoChange(input: FeedAssistInput): boolean {
  const verifiedMs = input.verifiedAt ? Date.parse(input.verifiedAt) : Number.NaN;
  if (!Number.isFinite(verifiedMs) || (input.now ?? Date.now()) - verifiedMs >= FEED_ASSIST_MAX_AGE_MS) return false;
  // The feed must have been followed without a gap since the page was loaded.
  const continuousMs = input.continuousSince ? Date.parse(input.continuousSince) : Number.NaN;
  if (!Number.isFinite(continuousMs) || continuousMs > verifiedMs - FEED_ASSIST_CLOCK_SKEW_MS) return false;
  if (!input.entry) return true;
  const updatedMs = input.entry.publishedAt ? Date.parse(input.entry.publishedAt) : Number.NaN;
  if (!Number.isFinite(updatedMs) || updatedMs > verifiedMs - FEED_ASSIST_CLOCK_SKEW_MS) return false;
  const listed = magnetInfoHash(input.entry.magnet);
  const stored = magnetInfoHash(input.storedMagnet);
  return !listed || !stored || listed === stored;
}
