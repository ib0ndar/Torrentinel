import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { config } from "./config.js";
import type { SqliteDatabase } from "./db.js";
import { nowIso } from "./db.js";
import {
  NetworkCoverRetriever,
  type CoverRetriever,
} from "./cover-fetch.js";
import type { Release } from "./types.js";

interface CacheRow {
  subscription_id: string;
  source_url: string;
  content_type: string;
  file_name: string;
  byte_length: number;
  cached_at: string;
}

export interface CachedCover {
  bytes: ArrayBuffer;
  contentType: string;
  sourceUrl: string;
  cachedAt: string;
}

export interface CoverRefreshResult {
  cachedAt: string;
  contentType: string;
  byteLength: number;
  sourceUrl: string;
  retrievalFallbackErrors?: string;
}

export interface CoverCacheStore {
  has(subscriptionId: string): boolean;
  refresh(subscriptionId: string, release: Release): Promise<CoverRefreshResult>;
  read(subscriptionId: string): Promise<CachedCover | undefined>;
  remove(subscriptionId: string): Promise<void>;
}

export class CoverCache implements CoverCacheStore {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly directory = config.coverCacheDir,
    private readonly retriever: CoverRetriever = new NetworkCoverRetriever(),
  ) {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.pruneOrphans();
  }

  has(subscriptionId: string): boolean {
    const row = this.row(subscriptionId);
    if (!row) return false;
    try {
      const path = this.path(row.file_name);
      return existsSync(path) && statSync(path).size === row.byte_length;
    } catch {
      return false;
    }
  }

  async refresh(subscriptionId: string, release: Release): Promise<CoverRefreshResult> {
    if (!release.coverUrl) throw new Error("tracker did not provide a cover URL");
    const retrieval = await this.retriever.retrieve(release.coverUrl, release.url);
    const bytes = Buffer.from(retrieval.asset.bytes);
    const fileName = cacheFileName(subscriptionId, bytes);
    const finalPath = this.path(fileName);
    const temporaryPath = this.path(`.${fileName}.${randomBytes(8).toString("hex")}.tmp`);
    const previous = this.row(subscriptionId);
    const cachedAt = nowIso();

    try {
      await writeFile(temporaryPath, bytes, { mode: 0o600 });
      await rename(temporaryPath, finalPath);
      this.db.prepare(`
        INSERT INTO subscription_cover_cache (
          subscription_id, source_url, content_type, file_name, byte_length, cached_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(subscription_id) DO UPDATE SET
          source_url = excluded.source_url,
          content_type = excluded.content_type,
          file_name = excluded.file_name,
          byte_length = excluded.byte_length,
          cached_at = excluded.cached_at
      `).run(
        subscriptionId,
        release.coverUrl,
        retrieval.asset.contentType,
        fileName,
        bytes.length,
        cachedAt,
      );
    } finally {
      await rm(temporaryPath, { force: true });
    }

    if (previous && previous.file_name !== fileName) await unlink(this.path(previous.file_name)).catch(() => undefined);
    return {
      cachedAt,
      contentType: retrieval.asset.contentType,
      byteLength: bytes.length,
      sourceUrl: release.coverUrl,
      retrievalFallbackErrors: retrieval.fallbackErrors,
    };
  }

  async read(subscriptionId: string): Promise<CachedCover | undefined> {
    const row = this.row(subscriptionId);
    if (!row) return undefined;
    try {
      const bytes = await readFile(this.path(row.file_name));
      if (bytes.length !== row.byte_length) {
        await this.remove(subscriptionId);
        return undefined;
      }
      return {
        bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
        contentType: row.content_type,
        sourceUrl: row.source_url,
        cachedAt: row.cached_at,
      };
    } catch (error) {
      if (isMissingFile(error)) {
        this.db.prepare("DELETE FROM subscription_cover_cache WHERE subscription_id = ?").run(subscriptionId);
        return undefined;
      }
      throw error;
    }
  }

  async remove(subscriptionId: string): Promise<void> {
    const row = this.row(subscriptionId);
    this.db.prepare("DELETE FROM subscription_cover_cache WHERE subscription_id = ?").run(subscriptionId);
    if (row) await unlink(this.path(row.file_name)).catch(() => undefined);
  }

  private row(subscriptionId: string): CacheRow | undefined {
    return this.db.prepare(`
      SELECT subscription_id, source_url, content_type, file_name, byte_length, cached_at
      FROM subscription_cover_cache WHERE subscription_id = ?
    `).get(subscriptionId) as CacheRow | undefined;
  }

  private path(fileName: string): string {
    if (basename(fileName) !== fileName) throw new Error("Invalid cached cover filename");
    return resolve(this.directory, fileName);
  }

  private pruneOrphans(): void {
    const referenced = new Set((this.db.prepare("SELECT file_name FROM subscription_cover_cache").all() as Array<{ file_name: string }>)
      .map((row) => row.file_name));
    for (const entry of readdirSync(this.directory, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (!referenced.has(entry.name)) {
        try { unlinkSync(this.path(entry.name)); } catch { /* Retry on the next application start. */ }
      }
    }
  }
}

function cacheFileName(subscriptionId: string, bytes: Buffer): string {
  const subscriptionHash = createHash("sha256").update(subscriptionId).digest("hex").slice(0, 20);
  const contentHash = createHash("sha256").update(bytes).digest("hex").slice(0, 24);
  return `${subscriptionHash}-${contentHash}.cover`;
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
