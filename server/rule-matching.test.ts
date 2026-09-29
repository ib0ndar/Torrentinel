import { describe, expect, it } from "vitest";
import { compileTitleMatcher, normalizeTitle, parseTerms, titleMatches } from "./rule-matching.js";

describe("compiled rule matching", () => {
  it("preserves the original matching semantics, including empty phrases and whitespace", () => {
    const titles = ["The SHOW 2160P", "СЕРИАЛ WEB-DL", "Show Trailer", "", " Show "];
    const phrases = [[], ["show"], ["Сериал", "web-dl"], [""], [" show "], ["show", "2160p"]];
    for (const required of phrases) {
      for (const ignored of phrases) {
        const compiled = compileTitleMatcher(required, ignored);
        for (const title of titles) {
          const normalized = title.toLocaleLowerCase("ru-RU");
          const expected = required.every((term) => normalized.includes(term.toLocaleLowerCase("ru-RU")))
            && !ignored.some((term) => normalized.includes(term.toLocaleLowerCase("ru-RU")));
          expect(compiled(normalizeTitle(title))).toBe(expected);
          expect(titleMatches(title, required, ignored)).toBe(expected);
        }
      }
    }
  });

  it("handles malformed stored terms and preserves string coercion", () => {
    expect(parseTerms("not-json")).toEqual([]);
    expect(parseTerms("null")).toEqual([]);
    expect(parseTerms('{"term":"show"}')).toEqual([]);
    expect(parseTerms('["Show",12,null]')).toEqual(["Show", "12", "null"]);
  });
});
