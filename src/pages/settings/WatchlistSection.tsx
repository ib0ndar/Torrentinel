import { type ChangeEvent, useState } from "react";
import { api, jsonBody } from "../../api";
import { Field } from "../../components/UI";
import { errorMessage } from "../../format";
import { useI18n } from "../../i18n";
import type { Notify } from "../../types";
import { SettingsSection } from "./SettingsSection";

interface Summary {
  collections: { name: string; create: boolean; adding: number; duplicates: string[]; unsupported: string[] }[];
}

export function WatchlistSection({ notify, onChanged }: { notify: Notify; onChanged?: () => Promise<void> }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [review, setReview] = useState<{ file: unknown; summary: Summary; applied: boolean }>();

  async function download() {
    setBusy(true);
    try {
      const result = await api<{ watchlist: unknown; omitted: number }>("/api/watchlist");
      const url = URL.createObjectURL(new Blob([JSON.stringify(result.watchlist, null, 2) + "\n"], { type: "application/json" }));
      const anchor = document.createElement("a");
      anchor.download = "torrentinel-watchlist.json";
      anchor.href = url;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1_000);
      if (result.omitted) notify(t("Skipped {count} unsupported entries", { count: result.omitted }));
    } catch (error) { notify(errorMessage(error), "bad"); } finally { setBusy(false); }
  }

  async function preview(event: ChangeEvent<HTMLInputElement>) {
    const selected = event.target.files?.[0];
    event.target.value = "";
    if (!selected) return;
    setReview(undefined);
    if (selected.size > 4 * 1024 * 1024) { notify(t("The watchlist file exceeds 4 MB"), "bad"); return; }
    setBusy(true);
    try {
      const contents = await selected.text();
      let file: unknown;
      try { file = JSON.parse(contents); } catch { throw new Error(t("Choose a valid JSON watchlist")); }
      const summary = await api<Summary>("/api/watchlist/preview", { method: "POST", ...jsonBody(file) });
      setReview({ file, summary, applied: false });
    } catch (error) { notify(errorMessage(error), "bad"); } finally { setBusy(false); }
  }

  async function apply() {
    if (!review || busy || review.applied) return;
    setBusy(true);
    try {
      const summary = await api<Summary>("/api/watchlist/import", { method: "POST", ...jsonBody(review.file) });
      setReview({ ...review, summary, applied: true });
      notify(t("Watchlist imported"));
      await onChanged?.();
    } catch (error) { notify(errorMessage(error), "bad"); } finally { setBusy(false); }
  }

  const collections = review?.summary.collections ?? [];
  return <SettingsSection id="watchlist" description={t("Move collections, topic links, and rules between accounts or instances. Exported watchlists contain no credentials or history.")}>
    <div className="settings-control feature-form" aria-busy={busy}>
      <div><button type="button" className="button button--quiet" disabled={busy} onClick={() => void download()}>{t("Export watchlist")}</button></div>
      <Field label={t("Choose a watchlist file")}><input type="file" accept="application/json,.json" disabled={busy} onChange={(event) => void preview(event)} /></Field>
      {review && <section className="watchlist-review" aria-label={t("Import preview")}>
        <h3>{t(review.applied ? "Watchlist imported" : "Import preview")}</h3>
        {!collections.length && <p>{t("This watchlist is empty.")}</p>}
        {collections.map((collection) => <div key={collection.name} className="watchlist-review__collection">
          <strong>{collection.name}</strong>
          <p>{t(collection.create ? "New collection" : "Existing collection")} · {t(review.applied ? "{count} subscriptions added" : "{count} subscriptions to add", { count: collection.adding })}</p>
          {(["duplicates", "unsupported"] as const).map((key) => collection[key].length > 0 && <details key={key}>
            <summary>{t(key === "duplicates" ? "{count} duplicate entries" : "{count} unsupported entries", { count: collection[key].length })}</summary>
            <ul>{collection[key].slice(0, 20).map((entry, index) => <li key={index}>{entry}</li>)}
              {collection[key].length > 20 && <li>{t("+{count} more", { count: collection[key].length - 20 })}</li>}</ul>
          </details>)}
        </div>)}
        {!review.applied && collections.some(({ create, adding }) => create || adding > 0) &&
          <div className="inline-actions"><button type="button" className="button button--primary" disabled={busy} onClick={() => void apply()}>{t("Import watchlist")}</button></div>}
      </section>}
    </div>
  </SettingsSection>;
}
