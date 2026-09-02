import * as cheerio from "cheerio";
import type { DirectMonitor } from "../../core/contracts.js";
import { TrackerError } from "../../core/errors.js";
import { absoluteImageUrl, cleanText, externalIdFromUrl, fingerprintRelease } from "../../core/parsing.js";
import { IntegratedBrowserClient, type BrowserPage } from "../../core/transport/browser.js";
import type { Release } from "../../../types.js";
import { rutrackerManifest } from "./manifest.js";

export interface RutrackerDetailProvider {
  get(url: string, signal?: AbortSignal): Promise<BrowserPage>;
  close?(): Promise<void>;
}

export class RutrackerDirectMonitor implements DirectMonitor {
  constructor(
    private readonly normalizeUrl: (url: URL, baseUrl: string) => string,
    private readonly detailProvider: RutrackerDetailProvider = new IntegratedBrowserClient(),
  ) {}

  async fetchSnapshot(url: string, context: Parameters<DirectMonitor["fetchSnapshot"]>[1]) {
    const normalized = this.normalizeUrl(new URL(url), context.baseUrl);
    const externalId = externalIdFromUrl(normalized, [/[?&]t=(\d+)/i]);
    const page = await this.detailProvider.get(normalized, context.signal);
    const $ = cheerio.load(page.body);
    const title = cleanText($("h1.maintitle, .maintitle, h1").first().text());
    if (!title) throw new TrackerError("parse", "RuTracker topic page did not contain a title", { trackerKey: "rutracker" });
    const magnet = $("a.magnet-link[href^='magnet:'], a[href^='magnet:']").first().attr("href") || undefined;
    const coverImage = $(".post_body").first().find("img.postImg").first();
    const coverSource = coverImage.hasClass("post-img-broken")
      ? coverImage.attr("title")
      : coverImage.attr("data-src") || coverImage.attr("data-original") || coverImage.attr("src");
    const release: Release = {
      trackerKey: "rutracker",
      externalId,
      title,
      url: normalized,
      coverUrl: absoluteImageUrl(coverSource, normalized),
      magnet,
      metadata: {
        snapshotVersion: rutrackerManifest.snapshotVersion,
        coverObserved: true,
        detailSource: "browser-session",
        infoHash: magnetInfoHash(magnet) || null,
      },
    };
    return { ...release, fingerprint: fingerprintRelease(release) };
  }

  close(): Promise<void> | undefined {
    return this.detailProvider.close?.();
  }
}

function magnetInfoHash(magnet: string | undefined): string | undefined {
  if (!magnet) return undefined;
  try {
    const exactTopic = new URL(magnet).searchParams.getAll("xt")
      .find((value) => value.toLocaleLowerCase("en-US").startsWith("urn:btih:"));
    return exactTopic?.slice("urn:btih:".length).toLocaleUpperCase("en-US") || undefined;
  } catch {
    return undefined;
  }
}
