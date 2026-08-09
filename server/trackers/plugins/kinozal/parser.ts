import * as cheerio from "cheerio";
import type { Release } from "../../../types.js";
import {
  absoluteImageUrl,
  absoluteUrl,
  cleanText,
  externalIdFromUrl,
  labeledValue,
  normalizeTrackerChangeMarker,
  uniqueReleases,
} from "../../core/parsing.js";
import { TrackerError } from "../../core/errors.js";
import { kinozalManifest } from "./manifest.js";

export function parseKinozalDirect(body: string, normalizedUrl: string): Release {
  const $ = cheerio.load(body);
  const title = cleanText($("h1, .r1 h1, #details h1").first().text())
    || cleanText($("meta[property='og:title']").attr("content"))
    || cleanText($("title").text().replace(/\s*[-–—|]\s*Кинозал.*$/i, ""));
  if (!title) throw new TrackerError("parse", "Kinozal page did not contain a release title", { trackerKey: "kinozal" });

  const externalId = externalIdFromUrl(normalizedUrl, [/[?&]id=(\d+)/i]);
  const coverSource = $("img.p200, img[src*='/poster/']").first().attr("src")
    || $("meta[property='og:image']").first().attr("content");
  const rawChangeMarker = listItemValue($, ["Обновлен", "Залит"])
    || labeledValue($, ["Обновлен", "Залит", "Добавлен", "Дата добавления"]);
  const changeMarker = normalizeTrackerChangeMarker(rawChangeMarker);
  return {
    trackerKey: "kinozal",
    externalId,
    title,
    url: normalizedUrl,
    coverUrl: absoluteImageUrl(coverSource, normalizedUrl),
    magnet: $("a[href^='magnet:']").first().attr("href"),
    torrentUrl: absoluteUrl(
      $("a[href*='download.php?id='], a[href*='/download/']").first().attr("href") || `/download.php?id=${externalId}`,
      normalizedUrl,
    ),
    metadata: {
      snapshotVersion: kinozalManifest.snapshotVersion,
      coverObserved: true,
      changeMarker: changeMarker || null,
      size: labeledValue($, ["Размер"]) || null,
      category: labeledValue($, ["Категория"]) || null,
    },
  };
}

export function parseKinozalRecent(body: string, baseUrl: string): Release[] {
  const $ = cheerio.load(body);
  const releases: Release[] = [];
  $("a[href*='details.php?id=']").each((_, element) => {
    const href = $(element).attr("href");
    const title = cleanText($(element).text()) || cleanText($(element).attr("title"));
    if (!href || !title) return;
    const releaseUrl = absoluteUrl(href, baseUrl);
    if (!releaseUrl) return;
    const row = $(element).closest("tr");
    const externalId = externalIdFromUrl(releaseUrl, [/[?&]id=(\d+)/i]);
    releases.push({
      trackerKey: "kinozal",
      externalId,
      title,
      url: releaseUrl,
      magnet: row.find("a[href^='magnet:']").first().attr("href"),
      torrentUrl: absoluteUrl(row.find("a[href*='download.php?id=']").first().attr("href") || `/download.php?id=${externalId}`, baseUrl),
      metadata: { size: cleanText(row.find(".s, .size").first().text()) || null },
    });
  });
  if (releases.length === 0) {
    throw new TrackerError("parse", "Kinozal recent page did not contain any releases", { trackerKey: "kinozal" });
  }
  return uniqueReleases(releases);
}

function listItemValue($: cheerio.CheerioAPI, labels: string[]): string | undefined {
  const wanted = labels.map((label) => label.toLocaleLowerCase("ru-RU"));
  let value: string | undefined;
  $("li").each((_, element) => {
    if (value) return;
    const text = cleanText($(element).text());
    const lower = text.toLocaleLowerCase("ru-RU");
    const label = wanted.find((candidate) => {
      if (!lower.startsWith(candidate)) return false;
      const nextCharacter = lower.charAt(candidate.length);
      return !nextCharacter || !/\p{L}/u.test(nextCharacter);
    });
    if (!label) return;
    value = cleanText(text.slice(label.length)) || undefined;
  });
  return value;
}
