// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { getLanguage, LANGUAGE_STORAGE_KEY, PLURALS, preferredLanguage, russian, setLanguage, translate } from "./i18n";
import { diagnosticLabel, formatPollInterval, relativeTime } from "./format";

afterEach(() => setLanguage("en"));
describe("English and Russian localization", () => {
  it("defaults to English and interpolates values without translating user content", () => {
    expect(getLanguage()).toBe("en"); expect(translate("Delete “{name}”?", { name: "Settings" })).toBe("Delete “Settings”?");
    setLanguage("ru"); expect(translate("Delete “{name}”?", { name: "Settings" })).toBe("Удалить «Settings»?"); expect(document.documentElement.lang).toBe("ru");
    expect(translate("Unknown user text")).toBe("Unknown user text");
  });
  it("starts in the language last used in the browser, else the first supported browser language, and remembers changes", () => {
    expect(preferredLanguage(null, ["de-DE", "ru-RU", "en-US"])).toBe("ru"); expect(preferredLanguage("en", ["ru-RU"])).toBe("en");
    expect(preferredLanguage("fr", ["fr-FR", "pl"])).toBe("en"); expect(preferredLanguage(null, [])).toBe("en");
    setLanguage("ru"); expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe("ru");
  });
  it("localizes date, time and interval formatting", () => {
    expect(formatPollInterval(90)).toBe("1h 30m"); setLanguage("ru"); expect(formatPollInterval(90)).toBe("1 ч 30 мин");
    expect(relativeTime(new Date(Date.now() - 120_000).toISOString())).toContain("минут");
  });
  it("maintains interpolation placeholders in every translation", () => {
    const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
    for (const [key, value] of Object.entries(russian)) { expect(value.trim(), key).not.toBe(""); expect(placeholders(value), key).toEqual(placeholders(key)); }
  });
  it("chooses singular and plural forms by count", () => {
    expect(translate("{count} subscriptions", { count: 1 })).toBe("1 subscription"); expect(translate("{count} subscriptions", { count: 0 })).toBe("0 subscriptions");
    expect(translate("{count} releases observed", { count: 1 })).toBe("1 release observed"); expect(translate("{count} new matches", { count: 21 })).toBe("21 new matches");
    expect(translate("Page {page} of {pages} · {total} entries", { page: 1, pages: 1, total: 1 })).toBe("Page 1 of 1 · 1 entry");
    setLanguage("ru");
    expect([1, 2, 5, 11, 21, 22, 25].map((count) => translate("{count} subscriptions", { count }))).toEqual(["1 подписка", "2 подписки", "5 подписок", "11 подписок", "21 подписка", "22 подписки", "25 подписок"]);
    // Without Russian forms the plain translation already avoids agreement.
    expect(translate("{count} releases observed", { count: 1 })).toBe("Получено релизов: 1");
  });
  it("labels every diagnostics outcome and operation in both languages", () => {
    const identifiers = ["direct", "feed-poll", "rule-discovery", "rule-enrichment", "unchanged", "changed", "new-matches", "baseline", "rebaseline", "cover-backfill", "cover-baseline",
      "schema-upgrade", "enriched", "superseded", "removed", "error", "missing", "blocked", "auth", "parse", "network", "unsupported", "challenge", "temporarily-unavailable",
      "coverage-gap", "continuous", "recovered", "skipped", "delivered", "failed", "pending", "sending"];
    const english = identifiers.map(diagnosticLabel);
    for (const label of english) expect(label).toMatch(/^[A-Z][a-z]* ?[a-z ]*$/);
    setLanguage("ru");
    identifiers.forEach((identifier, index) => expect(diagnosticLabel(identifier), identifier).not.toBe(english[index]));
    expect([diagnosticLabel("continuous"), diagnosticLabel("recovered")]).toEqual(["Непрерывно", "Пропуск восстановлен"]);
    // An identifier without a label still uses its own translation.
    expect(diagnosticLabel("seeded")).toBe("В базе");
  });
  it("keeps the placeholders of every plural form and translates every plural message", () => {
    const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
    for (const [key, forms] of Object.entries(PLURALS)) {
      expect(russian[key], key).toBeTruthy();
      for (const form of [forms.en.one, ...Object.values(forms.ru ?? {})]) expect(placeholders(form), form).toEqual(placeholders(key));
    }
  });
});
