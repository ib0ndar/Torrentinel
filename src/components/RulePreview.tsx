import { useEffect, useRef, useState } from "react";
import { api, jsonBody } from "../api";
import { absoluteTime, errorMessage, webHref } from "../format";
import { useI18n } from "../i18n";
import type { TrackerKey } from "../types";
import { TrackerTag } from "./UI";

type Preview = { trackerKey: TrackerKey } & (
  { status: "disabled" | "credentials" | "unavailable" } |
  { status: "ok"; source: "feed" | "recent-list" | "search"; sampledAt: string; oldestAt?: string; newestAt?: string;
    inspected: number; matched: number; matches: { title: string; url: string }[];
    excluded: { title: string; blockedBy: string[]; missing: string[] }[] }
);
const SOURCES = { feed: "Rolling feed", "recent-list": "Recent releases", search: "Tracker search" } as const;
const UNAVAILABLE = { disabled: "Tracker disabled", credentials: "Tracker credentials required", unavailable: "Sample unavailable" } as const;

export function RulePreview({ trackerKeys, requiredTerms, ignoredTerms }: {
  trackerKeys: TrackerKey[]; requiredTerms: string[]; ignoredTerms: string[];
}) {
  const { t, language } = useI18n();
  const sampleDate = (date: string) => date.length === 10
    ? new Date(date).toLocaleDateString(language, { dateStyle: "medium", timeZone: "UTC" }) : absoluteTime(date);
  const input = jsonBody({ trackerKeys, requiredTerms, ignoredTerms });
  const [result, setResult] = useState<{ key: string; trackers?: Preview[]; error?: string }>();
  const [loading, setLoading] = useState(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const key = String(input.body);
  const current = result?.key === key ? result : undefined;

  async function preview() {
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setResult(undefined);
    try {
      const { trackers } = await api<{ trackers: Preview[] }>("/api/rules/preview", { method: "POST", ...input, signal: controller.signal });
      if (!controller.signal.aborted) setResult({ key, trackers });
    } catch (error) {
      if (!controller.signal.aborted) setResult({ key, error: errorMessage(error) });
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }

  return <div className="rule-preview" aria-busy={loading}>
    <button type="button" className="button button--quiet" disabled={loading || !requiredTerms.length || !trackerKeys.length} onClick={() => void preview()}>
      {t(loading ? "Checking samples…" : "Preview rule")}
    </button>
    {current?.error && <p role="alert">{current.error}</p>}
    {current?.trackers && <div role="status">
      <p>{t("Matches contain every required phrase and no ignored phrases. Coverage depends on each tracker’s sample.")}</p>
      {current.trackers.map((tracker) => <section className="rule-preview__tracker" key={tracker.trackerKey}>
        <div className="rule-preview__heading"><TrackerTag tracker={tracker.trackerKey} />
          {tracker.status === "ok" ? t(SOURCES[tracker.source]) : t(UNAVAILABLE[tracker.status])}</div>
        {tracker.status === "ok" && <>
          <p>{t("{matched} of {inspected} sampled releases matched", { matched: tracker.matched, inspected: tracker.inspected })}
            {" · "}{tracker.oldestAt
              ? t("Dated releases from {start} to {end}", { start: sampleDate(tracker.oldestAt), end: sampleDate(tracker.newestAt ?? tracker.sampledAt) })
              : t("Sampled at {time}", { time: absoluteTime(tracker.sampledAt) })}</p>
          {!tracker.oldestAt && <p>{t("This sample has no release dates.")}</p>}
          {tracker.matches.length > 0 && <ul>{tracker.matches.map(({ title, url }, index) => <li key={index}>
            <a href={webHref(url)} target="_blank" rel="noreferrer">{title}</a>
          </li>)}</ul>}
          {tracker.excluded.length > 0 && <details><summary>{t("Why some releases did not match")}</summary>
            <ul>{tracker.excluded.map(({ title, blockedBy, missing }, index) => <li key={index}>{title}
              {blockedBy.length > 0 && <small>{t("Ignored phrases found: {phrases}", { phrases: blockedBy.join(", ") })}</small>}
              {missing.length > 0 && <small>{t("Required phrases missing: {phrases}", { phrases: missing.join(", ") })}</small>}
            </li>)}</ul>
          </details>}
        </>}
      </section>)}
    </div>}
  </div>;
}
