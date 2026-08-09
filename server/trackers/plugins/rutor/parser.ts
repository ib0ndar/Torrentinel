import * as cheerio from "cheerio";
import type { Release } from "../../../types.js";
import { TrackerError } from "../../core/errors.js";
import {
  absoluteImageUrl,
  absoluteUrl,
  cleanText,
  externalIdFromUrl,
  labeledValue,
  normalizeTrackerChangeMarker,
  uniqueReleases,
} from "../../core/parsing.js";
import { rutorManifest } from "./manifest.js";

export function parseRutorDirect(body: string, normalizedUrl: string): Release {
  const $ = cheerio.load(body);
  const title = cleanText($("h1").first().text())
    || cleanText($("title").text().replace(/^rutor\.(?:info|is)\s*::\s*/i, ""));
  if (!title) throw new TrackerError("parse", "Rutor page did not contain a release title", { trackerKey: "rutor" });

  const rawChangeMarker = labeledValue($, ["Обновлен", "Добавлен"]);
  const changeMarker = normalizeTrackerChangeMarker(rawChangeMarker);
  const coverSource = $("#details img[style*='float']").first().attr("src")
    || $("meta[property='og:image']").first().attr("content");
  return {
    trackerKey: "rutor",
    externalId: externalIdFromUrl(normalizedUrl, [/\/torrent\/(\d+)/i]),
    title,
    url: normalizedUrl,
    coverUrl: absoluteImageUrl(coverSource, normalizedUrl),
    magnet: $("a[href^='magnet:']").first().attr("href"),
    torrentUrl: absoluteUrl($("a[href*='/download/']").first().attr("href"), normalizedUrl),
    metadata: {
      snapshotVersion: rutorManifest.snapshotVersion,
      coverObserved: true,
      changeMarker: changeMarker || null,
      size: labeledValue($, ["Размер"]) || null,
      category: labeledValue($, ["Категория"]) || null,
    },
  };
}

export function parseRutorRecent(body: string, baseUrl: string): Release[] {
  const $ = cheerio.load(body);
  const releases: Release[] = [];
  $("a[href*='/torrent/']").each((_, element) => {
    const href = $(element).attr("href");
    const title = cleanText($(element).text());
    if (!href || !title || !/\/torrent\/\d+/i.test(href)) return;
    const row = $(element).closest("tr");
    const url = absoluteUrl(href, baseUrl);
    if (!url) return;
    releases.push({
      trackerKey: "rutor",
      externalId: externalIdFromUrl(url, [/\/torrent\/(\d+)/i]),
      title,
      url,
      magnet: row.find("a[href^='magnet:']").first().attr("href"),
      torrentUrl: absoluteUrl(row.find("a[href*='/download/']").first().attr("href"), baseUrl),
      metadata: { size: cleanText(row.find("td").eq(-2).text()) || null },
    });
  });
  if (releases.length === 0) {
    throw new TrackerError("parse", "Rutor recent page did not contain any releases", { trackerKey: "rutor" });
  }
  return uniqueReleases(releases);
}
