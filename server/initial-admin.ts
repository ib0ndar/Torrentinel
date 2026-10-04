import { compare, hash } from "bcryptjs";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { customAlphabet } from "nanoid";
import type { SqliteDatabase } from "./db.js";
import { nowIso } from "./db.js";
import { PASSWORD_CHANGE } from "./types.js";

export const INITIAL_ADMIN_PASSWORD_FILE = "initial-admin-password";

// Unambiguous characters in five groups of five: about 140 bits, easy to copy by hand.
const passwordCharacters = customAlphabet("23456789abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ", 25);

export interface InitialAdminOptions {
  /** Where a generated password is kept until it is changed (next to the encryption key). */
  file: string;
  /** INITIAL_ADMIN_PASSWORD, when the operator chose the first password. */
  configuredPassword?: string;
  log: (message: string) => void;
}

/**
 * Makes sure the first-run administrator account (still waiting for its first password change)
 * has a password only the operator knows: the configured one, or a generated one that is written
 * to a private file and logged. This also replaces the old built-in admin/admin password of
 * installations that were never signed in to, and ends any session that used it.
 */
export async function prepareInitialAdmin(db: SqliteDatabase, options: InitialAdminOptions): Promise<void> {
  const account = db.prepare("SELECT id, username, password_hash FROM users WHERE must_change_password = ? ORDER BY created_at LIMIT 1")
    .get(PASSWORD_CHANGE.initial) as { id: string; username: string; password_hash: string } | undefined;
  if (!account) {
    rmSync(options.file, { force: true });
    return;
  }
  if (options.configuredPassword) {
    if (!(await compare(options.configuredPassword, account.password_hash))) await replacePassword(db, account.id, options.configuredPassword);
    rmSync(options.file, { force: true });
    options.log(`First sign-in: account "${account.username}" with the password set in INITIAL_ADMIN_PASSWORD. It must be changed after signing in.`);
    return;
  }
  let password = readSavedPassword(options.file);
  if (!password || !(await compare(password, account.password_hash))) {
    password = generatePassword();
    await replacePassword(db, account.id, password);
    writeFileSync(options.file, `${password}\n`, { mode: 0o600 });
  }
  options.log(`First sign-in: account "${account.username}", password ${password} (also saved in ${options.file}). It must be changed after signing in.`);
}

/** Deletes the saved first-run password once no account is waiting for its first password change. */
export function forgetInitialAdminPassword(db: SqliteDatabase, file: string): void {
  if (db.prepare("SELECT 1 FROM users WHERE must_change_password = ?").get(PASSWORD_CHANGE.initial)) return;
  rmSync(file, { force: true });
}

async function replacePassword(db: SqliteDatabase, userId: string, password: string): Promise<void> {
  const passwordHash = await hash(password, 12);
  db.transaction(() => {
    db.prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?").run(passwordHash, nowIso(), userId);
    // Anyone signed in with an earlier first-run password must sign in again.
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
  })();
}

function readSavedPassword(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

function generatePassword(): string {
  return passwordCharacters().match(/.{5}/gu)!.join("-");
}
