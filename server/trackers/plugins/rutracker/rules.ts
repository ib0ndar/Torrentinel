import * as cheerio from "cheerio";
import type { RuleDiscoveryProvider, TrackerContext } from "../../core/contracts.js";
import { TrackerError } from "../../core/errors.js";
import { cleanText, externalIdFromUrl, uniqueReleases } from "../../core/parsing.js";
import { CookieSession } from "../../core/transport/http.js";
import type { Release } from "../../../types.js";

const RUTRACKER_FEED_URL = "https://feed.rutracker.cc/atom/f/0.atom";
const FEED_CACHE_MILLISECONDS = 60_000;

interface FeedEntry {
  externalId: string;
  title: string;
  updated?: string;
}

export class RutrackerRuleDiscovery implements RuleDiscoveryProvider {
  private readonly client = new CookieSession();
  private feedEntries: FeedEntry[] = [];
  private feedExpiresAt = 0;
  private feedRequest?: Promise<FeedEntry[]>;

  async discover(context: TrackerContext) {
    const entries = await this.loadFeed(context.signal);
    const timestamps = entries.map((entry) => entry.updated).filter((value): value is string => Boolean(value)).sort();
    return {
      releases: uniqueReleases(entries.map((entry) => releaseFromEntry(entry, context.baseUrl))),
      coverage: { source: "feed" as const, complete: false, oldestObservedAt: timestamps[0] },
      cursor: timestamps.at(-1),
    };
  }

  private async loadFeed(signal?: AbortSignal): Promise<FeedEntry[]> {
    if (this.feedExpiresAt > Date.now()) return this.feedEntries;
    if (this.feedRequest) return this.feedRequest;
    this.feedRequest = this.fetchFeed(signal).then((entries) => {
      this.feedEntries = entries;
      this.feedExpiresAt = Date.now() + FEED_CACHE_MILLISECONDS;
      return entries;
    }).finally(() => {
      this.feedRequest = undefined;
    });
    return this.feedRequest;
  }

  private async fetchFeed(signal?: AbortSignal): Promise<FeedEntry[]> {
    const result = await this.client.get(RUTRACKER_FEED_URL, signal);
    const $ = cheerio.load(result.body, { xmlMode: true });
    const entries: FeedEntry[] = [];
    $("entry").each((_, element) => {
      const title = cleanText($(element).find("title").first().text());
      const href = $(element).find("link[href]").first().attr("href") || "";
      if (!title || !/[?&]t=\d+/i.test(href)) return;
      entries.push({
        externalId: externalIdFromUrl(href, [/[?&]t=(\d+)/i]),
        title,
        updated: cleanText($(element).find("updated").first().text()) || undefined,
      });
    });
    if (entries.length === 0) {
      throw new TrackerError("parse", "RuTracker feed did not contain any releases", { trackerKey: "rutracker" });
    }
    return entries;
  }
}

function releaseFromEntry(entry: FeedEntry, baseUrl: string): Release {
  const url = new URL("/forum/viewtopic.php", baseUrl);
  url.searchParams.set("t", entry.externalId);
  return {
    trackerKey: "rutracker",
    externalId: entry.externalId,
    title: entry.title,
    url: url.toString(),
    publishedAt: entry.updated,
    metadata: { feedSeen: true, updated: entry.updated || null },
  };
}
