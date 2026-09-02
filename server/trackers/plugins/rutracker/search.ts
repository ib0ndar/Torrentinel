import { createHash } from "node:crypto";
import * as cheerio from "cheerio";
import type {
  DiscoveryBatch,
  RuleDiscoveryQuery,
  TrackerContext,
} from "../../core/contracts.js";
import { TrackerError } from "../../core/errors.js";
import {
  absoluteUrl,
  cleanText,
  externalIdFromUrl,
  uniqueReleases,
} from "../../core/parsing.js";
import { IntegratedBrowserClient, type BrowserPage } from "../../core/transport/browser.js";
import { CookieSession, type HttpResult } from "../../core/transport/http.js";
import type { Release } from "../../../types.js";

const MAX_RECOVERY_PAGES = 20;

export interface RutrackerClearanceProvider {
  get(url: string, signal?: AbortSignal): Promise<BrowserPage>;
  close?(): Promise<void>;
}

export interface RutrackerHttpSession {
  clear(): void;
  seedCookies(cookies: Array<{ name: string; value: string }>, userAgent?: string): void;
  get(url: string, signal?: AbortSignal): Promise<HttpResult>;
  postForm(
    url: string,
    values: Record<string, string>,
    signal?: AbortSignal,
    additionalHeaders?: RequestInit["headers"],
  ): Promise<HttpResult>;
}

interface SearchClient {
  clearance: RutrackerClearanceProvider;
  http: RutrackerHttpSession;
  authenticated: boolean;
}

interface ParsedSearchPage {
  releases: Release[];
  nextUrl?: string;
}

export class RutrackerSearchRecovery {
  private readonly clients = new Map<string, SearchClient>();

  constructor(
    private readonly clearanceFactory: (sessionId: string) => RutrackerClearanceProvider = (sessionId) => (
      new IntegratedBrowserClient(sessionId)
    ),
    private readonly httpFactory: () => RutrackerHttpSession = () => new CookieSession(),
  ) {}

  async recover(context: TrackerContext, query: RuleDiscoveryQuery, since: string): Promise<DiscoveryBatch> {
    const requiredTerms = query.requiredTerms.map((term) => term.trim()).filter(Boolean);
    if (requiredTerms.length === 0) {
      throw new TrackerError("unsupported", "RuTracker catch-up search requires at least one search phrase", {
        trackerKey: "rutracker",
      });
    }
    if (!context.userId || !context.username || !context.password) {
      throw new TrackerError("authentication", "RuTracker login is required to recover a feed coverage gap", {
        trackerKey: "rutracker",
      });
    }
    const sinceMs = Date.parse(since);
    if (!Number.isFinite(sinceMs)) {
      throw new TrackerError("parse", "RuTracker recovery start time is invalid", { trackerKey: "rutracker" });
    }

    const searchUrl = new URL("/forum/tracker.php", context.baseUrl);
    searchUrl.searchParams.set("nm", requiredTerms.join(" "));
    searchUrl.searchParams.set("o", "1");
    searchUrl.searchParams.set("s", "2");
    const client = this.clientFor(context.userId);
    let page = await this.openSearch(client, context, searchUrl);

    const releases: Release[] = [];
    let complete = false;
    let sourceUrl = page.url;
    for (let pageNumber = 0; pageNumber < MAX_RECOVERY_PAGES; pageNumber += 1) {
      if (isLoginPage(page)) {
        throw new TrackerError("authentication", "RuTracker login was not accepted for catch-up search", {
          trackerKey: "rutracker",
          url: page.url,
        });
      }
      const parsed = parseRutrackerSearch(page.body, context.baseUrl, page.url);
      releases.push(...parsed.releases.filter((release) => (
        !release.publishedAt || Date.parse(release.publishedAt) >= sinceMs
      )));
      sourceUrl = page.url;
      const oldestMs = oldestReleaseTime(parsed.releases);
      if ((oldestMs !== undefined && oldestMs < sinceMs) || !parsed.nextUrl) {
        complete = true;
        break;
      }
      page = await client.http.get(parsed.nextUrl, context.signal);
    }

    const unique = uniqueReleases(releases);
    const timestamps = unique
      .map((release) => release.publishedAt)
      .filter((value): value is string => Boolean(value))
      .sort();
    return {
      releases: unique,
      coverage: { source: "search", complete, oldestObservedAt: timestamps[0] },
      cursor: timestamps.at(-1),
      sourceUrl,
    };
  }

  async close(): Promise<void> {
    const clearanceProviders = new Set([...this.clients.values()].map((client) => client.clearance));
    await Promise.all([...clearanceProviders].map(async (clearance) => clearance.close?.()));
    this.clients.clear();
  }

  private clientFor(userId: string): SearchClient {
    const key = createHash("sha256").update(userId).digest("hex").slice(0, 16);
    let client = this.clients.get(key);
    if (!client) {
      client = {
        clearance: this.clearanceFactory(`torrentinel-rutracker-search-${key}`),
        http: this.httpFactory(),
        authenticated: false,
      };
      this.clients.set(key, client);
    }
    return client;
  }

  private async openSearch(client: SearchClient, context: TrackerContext, searchUrl: URL): Promise<HttpResult> {
    if (client.authenticated) {
      try {
        const existing = await client.http.get(searchUrl.toString(), context.signal);
        if (!isLoginPage(existing)) return existing;
      } catch (error) {
        if (!(error instanceof TrackerError) || !["authentication", "challenge"].includes(error.code)) throw error;
      }
      client.authenticated = false;
    }
    return this.loginAndSearch(client, context, searchUrl);
  }

  private async loginAndSearch(
    client: SearchClient,
    context: TrackerContext,
    searchUrl: URL,
  ): Promise<HttpResult> {
    const loginUrl = new URL("/forum/login.php", context.baseUrl);
    const clearance = await client.clearance.get(loginUrl.toString(), context.signal);
    if (!clearance.cookies?.length || !clearance.userAgent) {
      throw new TrackerError("challenge", "RuTracker detail resolver did not return reusable clearance cookies", {
        trackerKey: "rutracker",
        url: clearance.url,
        retryable: true,
      });
    }
    client.http.clear();
    client.http.seedCookies(clearance.cookies, clearance.userAgent);
    const redirect = `${searchUrl.pathname.replace(/^\/forum\//u, "")}${searchUrl.search}`;
    const result = await client.http.postForm(loginUrl.toString(), {
      login_username: context.username!,
      login_password: context.password!,
      login: "Вход",
      redirect,
    }, context.signal, {
      origin: loginUrl.origin,
      referer: loginUrl.toString(),
    });
    if (isLoginPage(result)) {
      throw new TrackerError("authentication", "RuTracker login was not accepted for catch-up search", {
        trackerKey: "rutracker",
        url: result.url,
      });
    }
    client.authenticated = true;
    return /\/forum\/tracker\.php/iu.test(new URL(result.url).pathname)
      ? result
      : client.http.get(searchUrl.toString(), context.signal);
  }
}

export function parseRutrackerSearch(body: string, baseUrl: string, pageUrl = baseUrl): ParsedSearchPage {
  const $ = cheerio.load(body);
  const releases: Release[] = [];
  $("#tor-tbl tr.hl-tr").each((_, rowElement) => {
    const row = $(rowElement);
    const topicLink = row.find("td.t-title-col a[href*='viewtopic.php?t=']").first();
    const href = topicLink.attr("href");
    const title = cleanText(topicLink.text());
    const releaseUrl = absoluteUrl(href, baseUrl);
    if (!releaseUrl || !title) return;
    const externalId = externalIdFromUrl(releaseUrl, [/[?&]t=(\d+)/iu]);
    const timestamp = Number.parseInt(row.find("td[data-ts_text]").last().attr("data-ts_text") || "", 10);
    releases.push({
      trackerKey: "rutracker",
      externalId,
      title,
      url: releaseUrl,
      publishedAt: Number.isFinite(timestamp) ? new Date(timestamp * 1_000).toISOString() : undefined,
      metadata: {
        recovered: true,
        category: cleanText(row.find("td.f-name-col").first().text()) || null,
      },
    });
  });

  if (releases.length === 0 && !$("#tor-tbl").length && !/ничего\s+не\s+найдено|не\s+найдено/iu.test(body)) {
    throw new TrackerError("parse", "RuTracker search page did not contain a recognizable results table", {
      trackerKey: "rutracker",
      url: pageUrl,
    });
  }

  const currentStart = Number.parseInt(new URL(pageUrl, baseUrl).searchParams.get("start") || "0", 10) || 0;
  const nextCandidates = $("a[href*='tracker.php'][href*='start=']").map((_, link) => {
    const resolved = absoluteUrl($(link).attr("href"), pageUrl);
    if (!resolved) return undefined;
    const start = Number.parseInt(new URL(resolved).searchParams.get("start") || "", 10);
    return Number.isFinite(start) && start > currentStart ? { start, url: resolved } : undefined;
  }).get().filter((value): value is { start: number; url: string } => Boolean(value));
  nextCandidates.sort((left, right) => left.start - right.start);
  return { releases: uniqueReleases(releases), nextUrl: nextCandidates[0]?.url };
}

function isLoginPage(page: Pick<BrowserPage, "url" | "body">): boolean {
  return /\/forum\/login\.php/iu.test(new URL(page.url).pathname)
    || /id=["']login-form-full["']/iu.test(page.body);
}

function oldestReleaseTime(releases: Release[]): number | undefined {
  const values = releases
    .map((release) => release.publishedAt ? Date.parse(release.publishedAt) : Number.NaN)
    .filter(Number.isFinite);
  return values.length > 0 ? Math.min(...values) : undefined;
}
