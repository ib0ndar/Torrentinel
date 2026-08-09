import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDatabase, type SqliteDatabase } from "./db.js";
import {
  DIAGNOSTIC_RETENTION_HOURS,
  diagnosticCutoffIso,
  pruneDiagnostics,
  recordTrackerObservation,
  startSchedulerRun,
} from "./diagnostics.js";

const cleanup: string[] = [];
let openDatabase: SqliteDatabase | undefined;

afterEach(() => {
  openDatabase?.close();
  openDatabase = undefined;
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("tracker diagnostics", () => {
  it("stores useful observations without retaining download links or URL secrets", () => {
    const db = testDatabase();
    const user = db.prepare("SELECT id FROM users LIMIT 1").get() as { id: string };
    const runId = startSchedulerRun(db, "test", new Date().toISOString());

    recordTrackerObservation(db, {
      runId,
      userId: user.id,
      trackerKey: "rutor",
      operation: "direct",
      outcome: "changed",
      requestedUrl: "https://person:password@rutor.is/torrent/42?api_key=secret-value&view=full#private",
      snapshot: {
        trackerKey: "rutor",
        externalId: "42",
        title: "Fixture release",
        url: "https://rutor.is/torrent/42",
        coverUrl: "https://images.example.test/42.jpg",
        magnet: "magnet:?xt=urn:btih:SECRET-HASH",
        torrentUrl: "https://rutor.is/download/secret-file.torrent",
        fingerprint: "fixture-fingerprint",
        metadata: { snapshotVersion: 2, changeMarker: "2026-08-09 10:00", ignoredSecret: "do-not-store" },
      },
      durationMs: 1250,
    });

    const row = db.prepare("SELECT * FROM tracker_observations").get() as Record<string, unknown>;
    expect(row).toMatchObject({
      tracker_key: "rutor",
      operation: "direct",
      outcome: "changed",
      external_id: "42",
      has_cover: 1,
      has_magnet: 1,
      has_torrent_file: 1,
      duration_ms: 1250,
    });
    expect(row.requested_url).toBe("https://rutor.is/torrent/42?api_key=%5Bredacted%5D&view=full");
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain("secret-value");
    expect(serialized).not.toContain("person");
    expect(serialized).not.toContain("password");
    expect(serialized).not.toContain("SECRET-HASH");
    expect(serialized).not.toContain("secret-file.torrent");
    expect(serialized).not.toContain("do-not-store");
  });

  it("removes observations and runs older than exactly 168 hours", () => {
    const db = testDatabase();
    const user = db.prepare("SELECT id FROM users LIMIT 1").get() as { id: string };
    const now = Date.now();
    const oldTimestamp = new Date(now - (DIAGNOSTIC_RETENTION_HOURS * 60 * 60 * 1_000) - 1).toISOString();
    const runId = startSchedulerRun(db, "old", oldTimestamp);
    recordTrackerObservation(db, {
      runId,
      userId: user.id,
      trackerKey: "rutor",
      operation: "rule-discovery",
      outcome: "unchanged",
      durationMs: 1,
      observedAt: oldTimestamp,
    });

    expect(diagnosticCutoffIso(now)).toBe(new Date(now - 168 * 60 * 60 * 1_000).toISOString());
    expect(pruneDiagnostics(db, now)).toEqual({ observations: 1, runs: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM tracker_observations").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM scheduler_runs").get()).toEqual({ count: 0 });
  });
});

function testDatabase(): SqliteDatabase {
  const directory = mkdtempSync(join(tmpdir(), "torrentinel-diagnostics-"));
  cleanup.push(directory);
  openDatabase = createDatabase(join(directory, "test.db"));
  return openDatabase;
}
