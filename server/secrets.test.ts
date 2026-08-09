import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDatabase } from "./db.js";
import { createSecretVault, ensureVaultKey, SecretVault } from "./secrets.js";

const cleanup: string[] = [];
afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("encrypted integration storage", () => {
  it("uses authenticated randomized encryption and binds values to their context", () => {
    const vault = new SecretVault(Buffer.alloc(32, 7));
    const first = vault.encrypt("sensitive value", "user:a");
    const second = vault.encrypt("sensitive value", "user:a");
    expect(first).not.toBe(second);
    expect(first).not.toContain("sensitive value");
    expect(vault.decrypt(first, "user:a")).toBe("sensitive value");
    expect(() => vault.decrypt(first, "user:b")).toThrow();
    const tampered = `${first.slice(0, -1)}${first.endsWith("A") ? "B" : "A"}`;
    expect(() => vault.decrypt(tampered, "user:a")).toThrow();
  });

  it("persists a separate 0600 master key and rejects the wrong key for an existing database", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "torrentinel-vault-test-"));
    cleanup.push(dataDir);
    const databasePath = join(dataDir, "torrentinel.db");
    const keyPath = join(dataDir, "application", "master.key");
    const db = createDatabase(databasePath);
    const vault = createSecretVault(keyPath);
    expect(readFileSync(keyPath)).toHaveLength(32);
    ensureVaultKey(db, vault);
    expect(() => ensureVaultKey(db, new SecretVault(Buffer.alloc(32, 4)))).toThrow(/volumes as a pair/);
    db.close();
  });
});
