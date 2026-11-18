import { nanoid } from "nanoid";
import { z } from "zod";
import { requireReadyUser } from "../auth.js";
import { nowIso, type SqliteDatabase } from "../db.js";
import { normalizeTitle } from "../rule-matching.js";
import { insertSubscription, normalizeTerms, publicTopicUrl, topicId } from "../subscription-store.js";
import { trackerRegistry } from "../trackers/index.js";
import { MONITOR_FILTERS, monitorFilter, type TrackerKey } from "../types.js";
import { adapterForUserUrl, jsonArray, parse, trackerKeySchema, urlSchema, type RouteServices } from "./shared.js";

const MAX_SUBSCRIPTIONS = 5_000;
const itemSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("direct"), url: urlSchema, enabled: z.boolean().default(true) }),
  z.object({ type: z.literal("rule"), trackerKeys: z.array(trackerKeySchema).min(1).max(3),
    requiredTerms: z.array(z.string()).min(1).max(30), ignoredTerms: z.array(z.string()).max(30).default([]),
    enabled: z.boolean().default(true) }),
]);
const watchlistSchema = z.object({
  format: z.literal("torrentinel-watchlist"), version: z.literal(1),
  collections: z.array(z.object({
    name: z.string().trim().min(1).max(80), defaultFilter: z.enum(MONITOR_FILTERS).default("all"),
    subscriptions: z.array(itemSchema).max(MAX_SUBSCRIPTIONS),
  })).max(MAX_SUBSCRIPTIONS),
}).refine((file) => file.collections.reduce((count, collection) => count + collection.subscriptions.length, 0) <= MAX_SUBSCRIPTIONS,
  { message: "Watchlist has too many subscriptions" });

type Watchlist = z.output<typeof watchlistSchema>;
type Entry = z.output<typeof itemSchema>;
type Rule = Extract<Entry, { type: "rule" }>;
type PreparedEntry = (Extract<Entry, { type: "direct" }> & { trackerKeys: TrackerKey[] }) | Rule;
interface CollectionRow { id: string; name: string; default_filter: string }
interface SubscriptionRow {
  collection_id: string; type: Entry["type"]; direct_url: string | null; tracker_keys: string | null;
  required_terms: string; ignored_terms: string; enabled: number;
}

export function registerWatchlistRoutes({ app, db }: RouteServices): void {
  app.get("/api/watchlist", { preHandler: requireReadyUser }, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    return exportWatchlist(db, request.user!.id);
  });
  for (const mode of ["preview", "import"] as const) {
    app.post(`/api/watchlist/${mode}`, { preHandler: requireReadyUser, bodyLimit: 4 * 1024 * 1024 }, async (request, reply) => {
      const watchlist = parse(watchlistSchema, request.body, reply);
      if (!watchlist || !request.user) return;
      const userId = request.user.id;
      if (mode === "preview") return planImport(db, userId, watchlist).summary;
      return db.transaction(() => {
        // Recompute against the current account so an intervening edit or import cannot create duplicates.
        const plan = planImport(db, userId, watchlist);
        const createCollection = db.prepare("INSERT INTO collections (id, user_id, name, default_filter, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)");
        const timestamp = nowIso();
        for (const collection of plan.collections.values()) {
          const { id, name, defaultFilter, create, entries } = collection;
          if (create) createCollection.run(id, userId, name, defaultFilter, timestamp, timestamp);
          for (const entry of entries) insertSubscription(db, { ...entry, userId, collectionId: id });
        }
        return plan.summary;
      }).immediate();
    });
  }
}

function accountWatchlist(db: SqliteDatabase, userId: string) {
  const collections = db.prepare("SELECT id, name, default_filter FROM collections WHERE user_id = ? ORDER BY created_at, rowid").all(userId) as CollectionRow[];
  const subscriptions = db.prepare(`SELECT s.collection_id, s.type, s.direct_url, s.required_terms, s.ignored_terms, s.enabled,
      (SELECT GROUP_CONCAT(st.tracker_key) FROM subscription_trackers st WHERE st.subscription_id = s.id) AS tracker_keys
    FROM subscriptions s WHERE s.user_id = ? ORDER BY s.created_at, s.rowid`).all(userId) as SubscriptionRow[];
  return { collections, subscriptions };
}

function portableEntry(row: SubscriptionRow): PreparedEntry | undefined {
  const trackerKeys = (row.tracker_keys?.split(",") ?? []).filter((key): key is TrackerKey => trackerKeySchema.safeParse(key).success);
  const enabled = Boolean(row.enabled);
  if (row.type === "rule") {
    const requiredTerms = jsonArray(row.required_terms);
    if (trackerKeys.length && requiredTerms.length) return { type: "rule", enabled, trackerKeys, requiredTerms, ignoredTerms: jsonArray(row.ignored_terms) };
  } else {
    const key = trackerKeys[0];
    const id = key && row.direct_url ? topicId(key, row.direct_url) : undefined;
    if (id) return { type: "direct", enabled, url: publicTopicUrl(key, id), trackerKeys: [key] };
  }
}

function exportWatchlist(db: SqliteDatabase, userId: string) {
  const account = accountWatchlist(db, userId);
  const collections = new Map(account.collections.map(({ id, name, default_filter }) => [
    id, { name, defaultFilter: monitorFilter(default_filter), subscriptions: [] as Entry[] },
  ]));
  let omitted = 0;
  for (const row of account.subscriptions) {
    const entry = portableEntry(row);
    if (!entry) { omitted++; continue; }
    collections.get(row.collection_id)?.subscriptions.push(entry.type === "direct" ? { type: "direct", url: entry.url, enabled: entry.enabled } : entry);
  }
  const watchlist = { format: "torrentinel-watchlist", version: 1, collections: [...collections.values()] } satisfies Watchlist;
  return { watchlist, omitted };
}

function prepareEntry(db: SqliteDatabase, userId: string, entry: Entry): PreparedEntry | undefined {
  if (entry.type === "direct") {
    const adapter = adapterForUserUrl(db, userId, entry.url);
    if (!adapter?.direct) return;
    const key = adapter.manifest.key, id = topicId(key, entry.url);
    if (id) return { ...entry, url: publicTopicUrl(key, id), trackerKeys: [key] };
  } else {
    const requiredTerms = normalizeTerms(entry.requiredTerms);
    if (requiredTerms.length && entry.trackerKeys.every((key) => trackerRegistry.get(key)?.rules)) {
      return { ...entry, requiredTerms, ignoredTerms: normalizeTerms(entry.ignoredTerms) };
    }
  }
}

function signature(entry: PreparedEntry): string {
  if (entry.type === "direct") return entry.url;
  const phrases = (terms: string[]) => [...new Set(normalizeTerms(terms).map(normalizeTitle))].sort();
  return JSON.stringify([[...new Set(entry.trackerKeys)].sort(), phrases(entry.requiredTerms), phrases(entry.ignoredTerms)]);
}

function planImport(db: SqliteDatabase, userId: string, watchlist: Watchlist) {
  const account = accountWatchlist(db, userId);
  const byName = new Map(account.collections.map((row) => [row.name, row]));
  const known = new Map(account.collections.map(({ id }) => [id, new Set<string>()]));
  for (const row of account.subscriptions) {
    const entry = portableEntry(row);
    if (entry) known.get(row.collection_id)?.add(signature(entry));
  }
  const collections = new Map<string, {
    id: string; name: string; defaultFilter: Watchlist["collections"][number]["defaultFilter"]; create: boolean;
    entries: PreparedEntry[]; seen: Set<string>; duplicates: string[]; unsupported: string[];
  }>();
  for (const incoming of watchlist.collections) {
    let collection = collections.get(incoming.name);
    if (!collection) {
      const existing = byName.get(incoming.name);
      collection = { id: existing?.id ?? nanoid(), name: incoming.name, defaultFilter: incoming.defaultFilter,
        create: !existing, entries: [], seen: existing ? known.get(existing.id)! : new Set(), duplicates: [], unsupported: [] };
      collections.set(incoming.name, collection);
    }
    for (const entry of incoming.subscriptions) {
      const prepared = prepareEntry(db, userId, entry);
      const label = entry.type === "direct" ? entry.url : entry.requiredTerms.join(" + ");
      if (!prepared) { collection.unsupported.push(label); continue; }
      const key = signature(prepared);
      if (collection.seen.has(key)) { collection.duplicates.push(label); continue; }
      collection.seen.add(key);
      collection.entries.push(prepared);
    }
  }
  const summary = { collections: [...collections.values()].map(({ name, create, entries, duplicates, unsupported }) => ({
    name, create, adding: entries.length, duplicates, unsupported,
  })) };
  return { collections, summary };
}
