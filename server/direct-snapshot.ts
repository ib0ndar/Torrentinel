import type { DirectSnapshot } from "./types.js";

type BaselineOutcome = "baseline" | "temporarily-unavailable" | "rebaseline" | "cover-backfill" | "schema-upgrade";

function metadata(value: string | null): Record<string, unknown> {
  try {
    const parsed: unknown = value ? JSON.parse(value) : null;
    if (typeof parsed !== "object" || parsed === null || !("metadata" in parsed)) return {};
    const result = parsed.metadata;
    return typeof result === "object" && result !== null && !Array.isArray(result) ? result as Record<string, unknown> : {};
  } catch { return {}; }
}

export function directSnapshotIsTemporarilyUnavailable(snapshot: DirectSnapshot): boolean {
  return snapshot.metadata?.feedSeen === false;
}
export function previousDirectSnapshotWasTemporaryUnavailable(value: string | null): boolean {
  return metadata(value).feedSeen === false;
}
export function previousDirectSnapshotLacksCoverObservation(value: string | null): boolean {
  return metadata(value).coverObserved !== true;
}
export function directSnapshotRequiresSilentSchemaUpgrade(value: string | null, current: DirectSnapshot): boolean {
  return typeof current.metadata?.snapshotVersion === "number" && metadata(value).snapshotVersion !== current.metadata.snapshotVersion;
}

export function directBaselineOutcome(initialized: number, previousFingerprint: string | null, previousSnapshot: string | null, current: DirectSnapshot): BaselineOutcome | undefined {
  if (!initialized || !previousFingerprint) return "baseline";
  if (directSnapshotIsTemporarilyUnavailable(current)) return "temporarily-unavailable";
  const previous = metadata(previousSnapshot);
  if (previous.feedSeen === false) return "rebaseline";
  if (previous.coverObserved !== true) return "cover-backfill";
  if (typeof current.metadata?.snapshotVersion === "number" && previous.snapshotVersion !== current.metadata.snapshotVersion) return "schema-upgrade";
  return undefined;
}
