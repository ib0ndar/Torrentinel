import { createHash } from "node:crypto";
import type { CheerioAPI } from "cheerio";
import type { Release, TrackerKey } from "../../types.js";

export function cleanText(value: string | undefined | null): string {
  return (value || "").replace(/\s+/g, " ").trim();
}

export function absoluteUrl(value: string | undefined, baseUrl: string): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return undefined;
  }
}

export function absoluteImageUrl(value: string | undefined, baseUrl: string): string | undefined {
  const resolved = absoluteUrl(value, baseUrl);
  if (!resolved) return undefined;
  const protocol = new URL(resolved).protocol;
  return protocol === "https:" || protocol === "http:" ? resolved : undefined;
}

export function labeledValue($: CheerioAPI, labels: string[]): string | undefined {
  const wanted = new Set(labels.map(normalizeLabel));
  let found: string | undefined;
  $("tr").each((_, row) => {
    if (found) return;
    const cells = $(row).find("th, td");
    if (cells.length < 2 || !wanted.has(normalizeLabel(cells.eq(0).text()))) return;
    found = cleanText(cells.eq(1).text()) || undefined;
  });
  return found;
}

export function externalIdFromUrl(url: string, patterns: RegExp[]): string {
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match?.[1]) return match[1];
  }
  return createHash("sha256").update(url).digest("hex").slice(0, 20);
}

export function fingerprintRelease(release: Omit<Release, "trackerKey"> & { trackerKey?: TrackerKey }): string {
  const stable = JSON.stringify({
    externalId: release.externalId,
    title: release.title,
    url: release.url,
    coverUrl: release.coverUrl || null,
    magnet: release.magnet || null,
    torrentUrl: release.torrentUrl || null,
    metadata: release.metadata || null,
  });
  return createHash("sha256").update(stable).digest("hex");
}

export function uniqueReleases(releases: Release[]): Release[] {
  const seen = new Set<string>();
  return releases.filter((release) => {
    const key = `${release.trackerKey}:${release.externalId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function normalizeTrackerChangeMarker(value: string | undefined, now = new Date()): string | undefined {
  let marker = cleanText(value).replace(/\s*\([^)]*\bназад\)\s*$/iu, "").trim();
  if (!marker) return undefined;

  const relative = marker.match(/^(сегодня|вчера|сейчас)(?:\s+в)?(?:\s+(\d{1,2}:\d{2}))?/iu);
  if (relative) {
    const date = zonedDateParts(now, "Europe/Moscow");
    if (relative[1].toLocaleLowerCase("ru-RU") === "вчера") shiftUtcDate(date, -1);
    const time = relative[2] || `${pad(date.hour)}:${pad(date.minute)}`;
    return `${date.year}-${pad(date.month)}-${pad(date.day)} ${time}`;
  }

  const russianDate = marker.match(/^(\d{1,2})\s+([а-яё]+)\s+(\d{4})(?:\s+в)?\s+(\d{1,2}:\d{2})/iu);
  if (russianDate) {
    const month = RUSSIAN_MONTHS[russianDate[2].toLocaleLowerCase("ru-RU")];
    if (month) return `${russianDate[3]}-${pad(month)}-${pad(Number(russianDate[1]))} ${russianDate[4]}`;
  }

  const numericDate = marker.match(/^(\d{1,2})[-./](\d{1,2})[-./](\d{4}|\d{2})(?:\s+(\d{1,2}:\d{2})(?::\d{2})?)?/u);
  if (numericDate) {
    const year = numericDate[3].length === 2 ? `20${numericDate[3]}` : numericDate[3];
    return `${year}-${pad(Number(numericDate[2]))}-${pad(Number(numericDate[1]))}${numericDate[4] ? ` ${numericDate[4]}` : ""}`;
  }

  marker = marker.replace(/\s+/g, " ");
  return marker || undefined;
}

const RUSSIAN_MONTHS: Record<string, number> = {
  января: 1, янв: 1,
  февраля: 2, фев: 2,
  марта: 3, мар: 3,
  апреля: 4, апр: 4,
  мая: 5, май: 5,
  июня: 6, июн: 6,
  июля: 7, июл: 7,
  августа: 8, авг: 8,
  сентября: 9, сен: 9,
  октября: 10, окт: 10,
  ноября: 11, ноя: 11,
  декабря: 12, дек: 12,
};

function normalizeLabel(value: string): string {
  return cleanText(value).toLocaleLowerCase("ru-RU").replace(/:$/, "");
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function zonedDateParts(value: Date, timeZone: string): { year: number; month: number; day: number; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value);
  const number = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value || 0);
  return { year: number("year"), month: number("month"), day: number("day"), hour: number("hour"), minute: number("minute") };
}

function shiftUtcDate(value: { year: number; month: number; day: number }, days: number): void {
  const shifted = new Date(Date.UTC(value.year, value.month - 1, value.day + days));
  value.year = shifted.getUTCFullYear();
  value.month = shifted.getUTCMonth() + 1;
  value.day = shifted.getUTCDate();
}
