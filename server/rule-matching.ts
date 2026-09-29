export function parseTerms(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export function normalizeTitle(value: string): string {
  return value.toLocaleLowerCase("ru-RU");
}

// Compile once per rule; callers can normalize each release once per batch.
export function compileTitleMatcher(required: string[], ignored: string[]): (normalizedTitle: string) => boolean {
  const requiredTerms = required.map(normalizeTitle);
  const ignoredTerms = ignored.map(normalizeTitle);
  return (title) => requiredTerms.every((term) => title.includes(term))
    && !ignoredTerms.some((term) => title.includes(term));
}

export function titleMatches(title: string, required: string[], ignored: string[]): boolean {
  return compileTitleMatcher(required, ignored)(normalizeTitle(title));
}
