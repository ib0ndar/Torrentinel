import { readFileSync } from "node:fs";
import { config } from "./config.js";
import { createDatabase } from "./db.js";
import {
  createSecretVault,
  ensureVaultKey,
  writeTrackerCredentials,
} from "./secrets.js";
import type { TrackerKey } from "./types.js";

const legacyCredentials: Array<{
  trackerKey: TrackerKey;
  usernamePath: string;
  passwordPath: string;
}> = [
  {
    trackerKey: "rutracker",
    usernamePath: "/run/secrets/rutracker_username",
    passwordPath: "/run/secrets/rutracker_password",
  },
  {
    trackerKey: "kinozal",
    usernamePath: "/run/secrets/kinozal_username",
    passwordPath: "/run/secrets/kinozal_password",
  },
];

const db = createDatabase();
try {
  const vault = createSecretVault(config.encryptionKeyPath);
  ensureVaultKey(db, vault);
  const users = db.prepare("SELECT id FROM users").all() as Array<{ id: string }>;
  let migrated = 0;
  for (const legacy of legacyCredentials) {
    const username = readRequiredSecret(legacy.usernamePath);
    const password = readRequiredSecret(legacy.passwordPath);
    for (const user of users) {
      writeTrackerCredentials(db, vault, user.id, legacy.trackerKey, { username, password });
      migrated += 1;
    }
  }
  console.log(`Migrated ${migrated} encrypted tracker credential records for ${users.length} user account(s).`);
} finally {
  db.close();
}

function readRequiredSecret(path: string): string {
  const value = readFileSync(path, "utf8").trim();
  if (!value) throw new Error(`Legacy secret at ${path} is empty`);
  return value;
}
