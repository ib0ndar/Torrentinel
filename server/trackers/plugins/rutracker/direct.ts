import * as cheerio from "cheerio";
import type { DirectMonitor } from "../../core/contracts.js";
import { TrackerError } from "../../core/errors.js";
import { absoluteImageUrl, cleanText, externalIdFromUrl, fingerprintRelease, magnetInfoHash, magnetLink } from "../../core/parsing.js";
import { IntegratedBrowserClient, type BrowserExpansion, type BrowserPage } from "../../core/transport/browser.js";
import type { Release } from "../../../types.js";
import { fileManifest, fileSize } from "../../../torrent-files.js";
import { rutrackerManifest } from "./manifest.js";

export interface RutrackerDetailProvider {
  get(url: string, signal?: AbortSignal, mirrorUrl?: string, expansion?: BrowserExpansion): Promise<BrowserPage>;
  close?(): Promise<void>;
}

export class RutrackerDirectMonitor implements DirectMonitor {
  constructor(
    private readonly normalizeUrl: (url: URL, baseUrl: string) => string,
    private readonly detailProvider: RutrackerDetailProvider = new IntegratedBrowserClient(undefined, { allowedHosts: rutrackerManifest.canonicalHosts }),
  ) {}

  async fetchSnapshot(url: string, context: Parameters<DirectMonitor["fetchSnapshot"]>[1], includeFiles?: boolean) {
    const normalized = this.normalizeUrl(new URL(url), context.baseUrl);
    const externalId = externalIdFromUrl(normalized, [/[?&]t=(\d+)/i]);
    const expansion = includeFiles ? { button: "#tor-filelist-btn", result: "#tor-filelist li.file" } : undefined;
    const page = await this.detailProvider.get(normalized, context.signal, context.baseUrl, expansion);
    const $ = cheerio.load(page.body);
    const title = cleanText($("h1.maintitle, .maintitle, h1").first().text());
    if (!title) throw new TrackerError("parse", "RuTracker topic page did not contain a title", { trackerKey: "rutracker" });
    const magnet = magnetLink($("a.magnet-link[href^='magnet:'], a[href^='magnet:']").first().attr("href"));
    const postImages = $(".post_body").first().find("img.postImg");
    // Release templates float the poster right ([img=right]); images above it can be title banners or
    // links to the release in other qualities. Without a right-aligned image the first image is the cover.
    const alignedImage = postImages.filter(".img-right").first();
    const coverImage = alignedImage.length > 0 ? alignedImage : postImages.first();
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
    const files = includeFiles ? parseRutrackerFiles($) : undefined;
    return { ...release, fingerprint: fingerprintRelease(release), ...(files ? { files } : {}) };
  }

  close(): Promise<void> | undefined {
    return this.detailProvider.close?.();
  }
}

function parseRutrackerFiles($: cheerio.CheerioAPI) {
  const tree = $("#tor-filelist");
  const name = (element: ReturnType<typeof $>) => element.children("div").first().find("b, span.b").first().text().trim();
  return fileManifest(tree.find("li.file").toArray().map((entry) => {
    const element = $(entry);
    const folders = element.parentsUntil(tree, "li.dir").toArray().reverse().map((folder) => name($(folder)));
    const path = [...folders, name(element)];
    const label = element.children("div").first();
    const size = fileSize(label.find("i").first().text()) ?? fileSize(label.find("s").first().text());
    return { path: path.every(Boolean) ? path.join("/") : "", size };
  }));
}
