import { resolve } from "node:path";

function integer(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function boolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`${name} must be true or false`);
}

const dataDir = resolve(process.env.DATA_DIR || "./data");
const appDataDir = resolve(process.env.APP_DATA_DIR || "./app-data");

function optionalHttpUrl(name: string, value: string | undefined): string | undefined {
  if (!value) return undefined;
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error(`${name} must use HTTP or HTTPS`);
  return url.toString().replace(/\/$/, "");
}

function browserSandbox(): "auto" | "true" | "false" {
  const raw = process.env.BROWSER_SANDBOX?.trim() || "auto";
  if (raw === "auto" || raw === "true" || raw === "false") return raw;
  throw new Error("BROWSER_SANDBOX must be auto, true or false");
}

// Fastify's trustProxy: false, true, or a comma-separated list of proxy addresses/CIDR ranges.
function trustProxy(): boolean | string {
  const raw = process.env.TRUST_PROXY?.trim();
  if (!raw || raw === "false") return false;
  if (raw === "true") return true;
  return raw;
}

export const config = {
  nodeEnv: process.env.NODE_ENV || "development",
  port: integer("PORT", process.env.NODE_ENV === "production" ? 8080 : 8787),
  host: process.env.HOST || "0.0.0.0",
  publicUrl: optionalHttpUrl("PUBLIC_URL", process.env.PUBLIC_URL),
  dataDir,
  appDataDir,
  databasePath: resolve(dataDir, "torrentinel.db"),
  encryptionKeyPath: resolve(appDataDir, "master.key"),
  coverCacheDir: resolve(appDataDir, "covers"),
  browserProfileDir: resolve(appDataDir, "browser-profiles"),
  pollIntervalMinutes: integer("POLL_INTERVAL_MINUTES", 60),
  pollStartupDelaySeconds: integer("POLL_STARTUP_DELAY_SECONDS", 20),
  requestTimeoutMs: integer("TRACKER_REQUEST_TIMEOUT_MS", 30_000),
  browserTimeoutMs: integer("BROWSER_TIMEOUT_MS", 120_000),
  browserHeadless: boolean("BROWSER_HEADLESS", true),
  browserChannel: process.env.BROWSER_CHANNEL || "auto",
  browserSandbox: browserSandbox(),
  sessionDays: integer("SESSION_DAYS", 30),
  sessionCookieSecure: process.env.SESSION_COOKIE_SECURE === "true",
  trustProxy: trustProxy(),
};

export type AppConfig = typeof config;
