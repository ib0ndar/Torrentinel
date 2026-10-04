import type { ReactNode } from "react";
import { capitalize, magnetHref, webHref } from "../format";
import { useI18n } from "../i18n";
import type { SubscriptionEvent } from "../types";
import { Icon } from "./Icon";

type Translate = ReturnType<typeof useI18n>["t"];
type Snapshot = { title?: unknown; magnet?: unknown; torrentUrl?: unknown };
const RELEASE_LIMIT = 5;
const text = (value: unknown) => typeof value === "string" && value.trim() ? value : undefined;
const snapshot = (value: unknown) => value && typeof value === "object" ? value as Snapshot : undefined;
// Older events may lack the previous/current snapshots or even the change list.
function directChanges(event: SubscriptionEvent): string[] {
  const changes = event.payload?.changes;
  return Array.isArray(changes) ? changes.filter((value): value is string => typeof value === "string" && value.length > 0) : [];
}
function matchedReleases(event: SubscriptionEvent): string[] {
  const releases = event.payload?.releases;
  return Array.isArray(releases) ? releases.map((release) => text((release as { title?: unknown } | null)?.title)).filter((title): title is string => Boolean(title)) : [];
}
function titleChange(event: SubscriptionEvent) {
  if (!directChanges(event).includes("title changed")) return;
  const previous = text(snapshot(event.payload?.previous)?.title), current = text(snapshot(event.payload?.current)?.title);
  return previous && current && previous !== current ? { previous, current } : undefined;
}
export function eventHeadline(event: SubscriptionEvent, t: Translate): string {
  if (event.kind === "direct-change") {
    const changes = directChanges(event);
    if (changes.length) return capitalize(changes.map((change) => t(change)).join(", "));
  }
  if (event.kind === "rule-match") {
    const releases = matchedReleases(event);
    if (releases.length) return releases.length === 1 ? t("New match: {title}", { title: releases[0] }) : t("{count} new matches", { count: releases.length });
  }
  return event.summary;
}
function TitleChange({ previous, current }: { previous: string; current: string }) {
  const { t } = useI18n();
  return <span className="change-title"><del><span className="visually-hidden">{t("Previous title:")} </span>{previous}</del><span className="change-title__arrow" aria-hidden="true">→</span><ins><span className="visually-hidden">{t("New title:")} </span>{current}</ins></span>;
}

// Full change details for the inspector's change history.
export function ChangeDetails({ event }: { event: SubscriptionEvent }) {
  const { t } = useI18n();
  const headline = <strong>{eventHeadline(event, t)}</strong>;
  if (event.kind === "rule-match") {
    const releases = matchedReleases(event);
    return <>{headline}{releases.length > 1 && <ul className="change-releases">{releases.slice(0, RELEASE_LIMIT).map((title, index) => <li key={index}>{title}</li>)}
      {releases.length > RELEASE_LIMIT && <li className="change-releases__more">{t("+{count} more", { count: releases.length - RELEASE_LIMIT })}</li>}</ul>}</>;
  }
  if (event.kind !== "direct-change") return headline;
  const changes = directChanges(event), title = titleChange(event);
  const previous = snapshot(event.payload?.previous), current = snapshot(event.payload?.current), links: ReactNode[] = [];
  if (changes.includes("magnet changed")) {
    const next = magnetHref(current?.magnet), old = magnetHref(previous?.magnet);
    if (next) links.push(<a key="magnet" href={next}><Icon name="magnet" size={15} />{t("Magnet")}</a>);
    if (old) links.push(<a key="previous-magnet" className="change-links__previous" href={old}><Icon name="magnet" size={15} />{t("Previous magnet")}</a>);
  }
  if (changes.includes("torrent file changed")) {
    const next = webHref(current?.torrentUrl), old = webHref(previous?.torrentUrl);
    if (next) links.push(<a key="torrent" href={next} target="_blank" rel="noreferrer"><Icon name="download" size={15} />{t("Torrent file")}</a>);
    if (old) links.push(<a key="previous-torrent" className="change-links__previous" href={old} target="_blank" rel="noreferrer"><Icon name="download" size={15} />{t("Previous torrent file")}</a>);
  }
  return <>{headline}{title && <TitleChange {...title} />}{links.length > 0 && <span className="source-links change-links">{links}</span>}</>;
}

// One-line form for the Activity list.
export function ChangeSummary({ event }: { event: SubscriptionEvent }) {
  const { t } = useI18n();
  const headline = eventHeadline(event, t), title = event.kind === "direct-change" ? titleChange(event) : undefined;
  const releases = event.kind === "rule-match" ? matchedReleases(event) : [];
  return <span className="change-summary">{headline}
    {title && <><span aria-hidden="true"> · </span><TitleChange {...title} /></>}
    {releases.length > 1 && <span className="change-summary__releases">{`: ${releases.slice(0, 2).join(", ")}${releases.length > 2 ? ` ${t("+{count} more", { count: releases.length - 2 })}` : ""}`}</span>}
  </span>;
}
