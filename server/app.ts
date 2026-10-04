import Fastify, { type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { createDatabase } from "./db.js";
import { registerAuth } from "./auth.js";
import { registerRoutes } from "./routes.js";
import { TelegramService } from "./telegram.js";
import { Scheduler } from "./scheduler.js";
import { createSecretVault, ensureVaultKey } from "./secrets.js";
import { closeTrackerAdapters } from "./trackers/index.js";
import { CoverCache } from "./cover-cache.js";
import { fetchCover, type CoverRetriever } from "./cover-fetch.js";
import { downloadCoverWithHttp2 } from "./cover-http2.js";

interface ApplicationOptions {
  databasePath?: string;
  logger?: boolean;
  staticAssets?: boolean;
  encryptionKeyPath?: string;
  telegramFetch?: typeof fetch;
  coverCacheDir?: string;
  coverRetriever?: CoverRetriever;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Session cookies are SameSite=Strict, which still treats sibling subdomains as the same site.
 * State-changing requests must therefore come from this application's own pages: browsers report
 * that in Sec-Fetch-Site, and older ones in Origin. Requests without either (scripts, curl) carry
 * no ambient browser credentials and are left alone.
 */
function crossSiteRequest(request: FastifyRequest): boolean {
  if (SAFE_METHODS.has(request.method)) return false;
  const fetchSite = request.headers["sec-fetch-site"];
  if (typeof fetchSite === "string") return fetchSite !== "same-origin" && fetchSite !== "none";
  const origin = request.headers.origin;
  if (origin === undefined) return false;
  let originHost: string;
  try {
    originHost = new URL(origin).host.toLowerCase();
  } catch {
    return true;
  }
  const forwardedHost = request.headers["x-forwarded-host"];
  const allowedHosts = [
    request.headers.host,
    ...(typeof forwardedHost === "string" ? forwardedHost.split(",") : []),
    config.publicUrl ? new URL(config.publicUrl).host : undefined,
  ].filter((value): value is string => Boolean(value)).map((value) => value.trim().toLowerCase());
  return !allowedHosts.includes(originHost);
}

export async function createApplication(options: ApplicationOptions = {}) {
  const app = Fastify({
    logger: options.logger === undefined
      ? { level: config.nodeEnv === "development" ? "debug" : "info" }
      : options.logger,
    bodyLimit: 1_000_000,
    trustProxy: config.trustProxy,
  });
  const db = createDatabase(options.databasePath);
  const vault = createSecretVault(options.encryptionKeyPath || config.encryptionKeyPath);
  ensureVaultKey(db, vault);
  const coverCacheDir = options.coverCacheDir
    || (options.databasePath ? resolve(dirname(options.databasePath), "covers") : config.coverCacheDir);
  const coverCache = new CoverCache(db, coverCacheDir, options.coverRetriever);
  const telegram = new TelegramService(
    db,
    vault,
    options.telegramFetch,
    config.publicUrl,
    fetchCover,
    downloadCoverWithHttp2,
    coverCache,
  );
  const scheduler = new Scheduler(db, telegram, vault, coverCache);

  await app.register(cookie);
  app.addHook("onRequest", async (request, reply) => {
    if (!crossSiteRequest(request)) return;
    await reply.code(403).send({ error: "Cross-site request blocked" });
  });
  app.addHook("onSend", async (_request, reply) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-frame-options", "DENY");
    reply.header("referrer-policy", "no-referrer");
    reply.header("permissions-policy", "camera=(), microphone=(), geolocation=()");
    reply.header("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https: http:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  });
  registerAuth(app, db);
  registerRoutes(app, db, scheduler, telegram, vault, coverCache);

  const currentDir = dirname(fileURLToPath(import.meta.url));
  const publicDir = resolve(currentDir, "../public");
  if (options.staticAssets !== false && existsSync(publicDir)) {
    await app.register(fastifyStatic, {
      root: publicDir,
      prefix: "/",
      wildcard: false,
    });
    app.setNotFoundHandler(async (request, reply) => {
      if (request.url.startsWith("/api/")) return reply.code(404).send({ error: "Not found" });
      return reply.type("text/html").sendFile("index.html");
    });
  }

  app.setErrorHandler((error, request, reply) => {
    request.log.error(error);
    if (reply.sent) return;
    const statusCode = typeof error === "object" && error && "statusCode" in error
      ? Number(error.statusCode)
      : 500;
    const message = error instanceof Error ? error.message : "Internal server error";
    void reply.code(statusCode >= 400 && statusCode < 500 ? statusCode : 500).send({
      error: statusCode >= 400 && statusCode < 500 ? message : "Internal server error",
    });
  });

  app.addHook("onClose", async () => {
    await scheduler.stop();
    await telegram.stop();
    await closeTrackerAdapters();
    db.close();
  });

  return { app, db, scheduler, telegram, vault, coverCache };
}
