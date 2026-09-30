// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { getLanguage, russian, setLanguage, translate } from "./i18n";
import { formatPollInterval, relativeTime } from "./format";

afterEach(() => setLanguage("en"));
describe("English and Russian localization", () => {
  it("defaults to English and interpolates values without translating user content", () => {
    expect(getLanguage()).toBe("en"); expect(translate("Delete “{name}”?", { name: "Settings" })).toBe("Delete “Settings”?");
    setLanguage("ru"); expect(translate("Delete “{name}”?", { name: "Settings" })).toBe("Удалить «Settings»?"); expect(document.documentElement.lang).toBe("ru");
    expect(translate("Unknown user text")).toBe("Unknown user text");
  });
  it("localizes date, time and interval formatting", () => {
    expect(formatPollInterval(90)).toBe("1h 30m"); setLanguage("ru"); expect(formatPollInterval(90)).toBe("1 ч 30 мин");
    expect(relativeTime(new Date(Date.now() - 120_000).toISOString())).toContain("минут");
  });
  it("maintains interpolation placeholders in every translation", () => {
    const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
    for (const [key, value] of Object.entries(russian)) { expect(value.trim(), key).not.toBe(""); expect(placeholders(value), key).toEqual(placeholders(key)); }
  });
});
