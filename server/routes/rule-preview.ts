import { z } from "zod";
import { requireReadyUser } from "../auth.js";
import { nowIso } from "../db.js";
import { compileTitleMatcher, normalizeTitle } from "../rule-matching.js";
import { readTrackerCredentials } from "../secrets.js";
import { normalizeTerms } from "../subscription-store.js";
import { trackerRegistry } from "../trackers/index.js";
import { parse, resolvedMirrors, trackerKeySchema, type RouteServices } from "./shared.js";

const schema = z.object({
  trackerKeys: z.array(trackerKeySchema).min(1).max(3),
  requiredTerms: z.array(z.string()).min(1).max(30),
  ignoredTerms: z.array(z.string()).max(30).default([]),
});

export function registerRulePreviewRoute({ app, db, vault }: RouteServices): void {
  const active = new Set<string>();
  app.post("/api/rules/preview", { preHandler: requireReadyUser, bodyLimit: 16_384 }, async (request, reply) => {
    const input = parse(schema, request.body, reply);
    if (!input || !request.user) return;
    const userId = request.user.id;
    const required = normalizeTerms(input.requiredTerms), ignored = normalizeTerms(input.ignoredTerms);
    if (!required.length) return reply.code(400).send({ error: "Add a required phrase to preview the rule" });
    if (active.has(userId) || active.size >= 4) return reply.code(429).send({ error: "A rule preview is already running. Try again shortly." });
    active.add(userId);
    try {
      const mirrors = resolvedMirrors(db, userId);
      const matchesTitle = compileTitleMatcher(required, ignored);
      const phrases = (terms: string[]) => terms.map((phrase) => ({ phrase, normalized: normalizeTitle(phrase) }));
      const requiredPhrases = phrases(required), ignoredPhrases = phrases(ignored);
      const trackers = await Promise.all([...new Set(input.trackerKeys)].map(async (trackerKey) => {
        const mirror = mirrors.find((entry) => entry.tracker_key === trackerKey);
        const plugin = trackerRegistry.get(trackerKey);
        if (!mirror?.enabled || !plugin?.rules) return { trackerKey, status: "disabled" as const };
        try {
          const credentials = readTrackerCredentials(db, vault, userId, trackerKey);
          if (!credentials && plugin.manifest.capabilities.authentication === "required") return { trackerKey, status: "credentials" as const };
          const batch = await plugin.rules.discover({ userId, baseUrl: mirror.base_url, ...credentials, signal: AbortSignal.timeout(25_000) }, { requiredTerms: required });
          const matches: { title: string; url: string }[] = [];
          type Rejection = { title: string; blockedBy: string[]; missing: string[] };
          const blocked: Rejection[] = [], other: Rejection[] = [];
          let matched = 0;
          for (const release of batch.releases) {
            const title = normalizeTitle(release.title);
            if (matchesTitle(title)) {
              matched++;
              if (matches.length < 8) matches.push({ title: release.title, url: release.url });
            } else if (blocked.length < 4) {
              const missing = requiredPhrases.filter(({ normalized }) => !title.includes(normalized)).map(({ phrase }) => phrase);
              const examples = missing.length ? other : blocked;
              if (examples.length < 4) examples.push({ title: release.title, missing,
                blockedBy: ignoredPhrases.filter(({ normalized }) => title.includes(normalized)).map(({ phrase }) => phrase) });
            }
          }
          const dates = batch.releases.map((release) => release.publishedAt).filter((date): date is string => Boolean(date && Number.isFinite(Date.parse(date)))).sort();
          return { trackerKey, status: "ok" as const, source: batch.coverage.source, sampledAt: nowIso(),
            oldestAt: batch.coverage.oldestObservedAt ?? dates[0], newestAt: dates.at(-1),
            inspected: batch.releases.length, matched, matches, excluded: [...blocked, ...other].slice(0, 4) };
        } catch {
          return { trackerKey, status: "unavailable" as const };
        }
      }));
      return { trackers };
    } finally {
      active.delete(userId);
    }
  });
}
