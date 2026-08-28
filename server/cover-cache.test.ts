import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CoverCache } from "./cover-cache.js";
import type { CoverRetriever } from "./cover-fetch.js";
import { createDatabase } from "./db.js";
import type { Release } from "./types.js";

const cleanup: string[] = [];

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("persistent subscription cover cache", () => {
  it("retains the last good cover after a refresh failure and replaces it atomically after recovery", async () => {
    const directory = mkdtempSync(join(tmpdir(), "torrentinel-cover-test-"));
    cleanup.push(directory);
    const db = createDatabase(join(directory, "test.db"));
    const covers = join(directory, "covers");
    const subscriptionId = insertDirectSubscription(db);
    const retrieve = vi.fn<CoverRetriever["retrieve"]>()
      .mockResolvedValueOnce({ asset: image([1, 2, 3], "image/jpeg") })
      .mockRejectedValueOnce(new Error("cover host timed out [ETIMEDOUT]"))
      .mockResolvedValueOnce({ asset: image([4, 5, 6, 7], "image/png") });
    const cache = new CoverCache(db, covers, { retrieve });
    const firstRelease = release("https://images.example/first.jpg");

    const first = await cache.refresh(subscriptionId, firstRelease);
    expect(first.byteLength).toBe(3);
    expect(new Uint8Array((await cache.read(subscriptionId))!.bytes)).toEqual(Uint8Array.from([1, 2, 3]));

    await expect(cache.refresh(subscriptionId, release("https://images.example/second.jpg")))
      .rejects.toThrow("ETIMEDOUT");
    expect(cache.has(subscriptionId)).toBe(true);
    expect(new Uint8Array((await cache.read(subscriptionId))!.bytes)).toEqual(Uint8Array.from([1, 2, 3]));

    const recovered = await cache.refresh(subscriptionId, release("https://images.example/second.jpg"));
    expect(recovered).toMatchObject({ byteLength: 4, contentType: "image/png" });
    expect(new Uint8Array((await cache.read(subscriptionId))!.bytes)).toEqual(Uint8Array.from([4, 5, 6, 7]));
    expect(readdirSync(covers).filter((name) => name.endsWith(".cover"))).toHaveLength(1);

    const afterRestart = new CoverCache(db, covers, { retrieve });
    expect(new Uint8Array((await afterRestart.read(subscriptionId))!.bytes)).toEqual(Uint8Array.from([4, 5, 6, 7]));
    db.close();
  });
});

function insertDirectSubscription(db: ReturnType<typeof createDatabase>): string {
  const user = db.prepare("SELECT id FROM users WHERE username = 'admin'").get() as { id: string };
  const collection = db.prepare("SELECT id FROM collections WHERE user_id = ?").get(user.id) as { id: string };
  const timestamp = new Date().toISOString();
  db.prepare(`
    INSERT INTO subscriptions (
      id, user_id, collection_id, type, name, direct_url, created_at, updated_at
    ) VALUES ('cover-test', ?, ?, 'direct', 'Cover test', 'https://rutor.is/torrent/1/test', ?, ?)
  `).run(user.id, collection.id, timestamp, timestamp);
  return "cover-test";
}

function release(coverUrl: string): Release {
  return {
    trackerKey: "rutor",
    externalId: "1",
    title: "Cover test",
    url: "https://rutor.is/torrent/1/test",
    coverUrl,
  };
}

function image(bytes: number[], contentType: string): { bytes: ArrayBuffer; contentType: string } {
  return { bytes: Uint8Array.from(bytes).buffer as ArrayBuffer, contentType };
}
