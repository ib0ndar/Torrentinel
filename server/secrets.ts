import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type { SqliteDatabase } from "./db.js";
import { nowIso } from "./db.js";
import type { TrackerKey } from "./types.js";

const KEY_BYTES = 32;
const IV_BYTES = 12;
const FORMAT_VERSION = "v1";
const KEY_CHECK_AAD = "torrentinel:vault:key-check";
const KEY_CHECK_VALUE = "torrentinel-vault-ready";

export class SecretVault {
  constructor(private readonly key: Buffer) {
    if (key.length !== KEY_BYTES) throw new Error("The encryption key must contain exactly 32 bytes");
  }

  encrypt(value: string, aad: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(aad, "utf8"));
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [FORMAT_VERSION, iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(":");
  }

  decrypt(value: string, aad: string): string {
    const [version, encodedIv, encodedTag, encodedCiphertext, extra] = value.split(":");
    if (version !== FORMAT_VERSION || !encodedIv || !encodedTag || encodedCiphertext === undefined || extra !== undefined) {
      throw new Error("Unsupported encrypted value format");
    }
    const iv = Buffer.from(encodedIv, "base64url");
    const tag = Buffer.from(encodedTag, "base64url");
    const ciphertext = Buffer.from(encodedCiphertext, "base64url");
    if (iv.length !== IV_BYTES || tag.length !== 16) throw new Error("Invalid encrypted value");
    const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  }
}

export function createSecretVault(keyPath: string): SecretVault {
  mkdirSync(dirname(keyPath), { recursive: true, mode: 0o700 });
  let key: Buffer;
  try {
    key = readFileSync(keyPath);
  } catch (error) {
    if (!isMissingFile(error)) throw error;
    const generated = randomBytes(KEY_BYTES);
    try {
      writeFileSync(keyPath, generated, { flag: "wx", mode: 0o600 });
      key = generated;
    } catch (writeError) {
      if (!isAlreadyExists(writeError)) throw writeError;
      key = readFileSync(keyPath);
    }
  }
  if (key.length !== KEY_BYTES) throw new Error(`Invalid encryption key at ${keyPath}`);
  chmodSync(keyPath, 0o600);
  return new SecretVault(key);
}

export function ensureVaultKey(db: SqliteDatabase, vault: SecretVault): void {
  const row = db.prepare("SELECT value FROM app_state WHERE key = 'vault_key_check'").get() as { value: string } | undefined;
  if (!row) {
    db.prepare("INSERT INTO app_state (key, value, updated_at) VALUES ('vault_key_check', ?, ?)")
      .run(vault.encrypt(KEY_CHECK_VALUE, KEY_CHECK_AAD), nowIso());
    return;
  }
  let decrypted: string;
  try {
    decrypted = vault.decrypt(row.value, KEY_CHECK_AAD);
  } catch {
    throw new Error("The application encryption key does not match this database. Restore the application and database volumes as a pair.");
  }
  const actual = Buffer.from(decrypted);
  const expected = Buffer.from(KEY_CHECK_VALUE);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error("The application encryption key does not match this database. Restore the application and database volumes as a pair.");
  }
}

export interface StoredTrackerCredentials {
  username: string;
  password: string;
}

export function trackerCredentialAad(userId: string, trackerKey: TrackerKey, field: "username" | "password"): string {
  return `torrentinel:tracker:${userId}:${trackerKey}:${field}`;
}

export function readTrackerCredentials(
  db: SqliteDatabase,
  vault: SecretVault,
  userId: string,
  trackerKey: TrackerKey,
): StoredTrackerCredentials | undefined {
  const row = db.prepare(`
    SELECT username_encrypted, password_encrypted
    FROM user_tracker_credentials WHERE user_id = ? AND tracker_key = ?
  `).get(userId, trackerKey) as { username_encrypted: string; password_encrypted: string } | undefined;
  if (!row) return undefined;
  return {
    username: vault.decrypt(row.username_encrypted, trackerCredentialAad(userId, trackerKey, "username")),
    password: vault.decrypt(row.password_encrypted, trackerCredentialAad(userId, trackerKey, "password")),
  };
}

export function writeTrackerCredentials(
  db: SqliteDatabase,
  vault: SecretVault,
  userId: string,
  trackerKey: TrackerKey,
  credentials: StoredTrackerCredentials,
): void {
  db.prepare(`
    INSERT INTO user_tracker_credentials
      (user_id, tracker_key, username_encrypted, password_encrypted, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id, tracker_key) DO UPDATE SET
      username_encrypted = excluded.username_encrypted,
      password_encrypted = excluded.password_encrypted,
      updated_at = excluded.updated_at
  `).run(
    userId,
    trackerKey,
    vault.encrypt(credentials.username, trackerCredentialAad(userId, trackerKey, "username")),
    vault.encrypt(credentials.password, trackerCredentialAad(userId, trackerKey, "password")),
    nowIso(),
  );
}

export function telegramTokenAad(userId: string): string {
  return `torrentinel:telegram:${userId}:token`;
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function isAlreadyExists(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "EEXIST");
}
