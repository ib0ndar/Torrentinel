import type { FastifyInstance } from "fastify";
import type { SqliteDatabase } from "./db.js";
import type { Scheduler } from "./scheduler.js";
import type { TelegramService } from "./telegram.js";
import type { SecretVault } from "./secrets.js";
import type { CoverCacheStore } from "./cover-cache.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerCollectionRoutes } from "./routes/collections.js";
import { registerSubscriptionRoutes } from "./routes/subscriptions.js";
import { registerActivityRoutes } from "./routes/activity.js";
import { registerSettingsRoutes } from "./routes/settings.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerSystemRoutes } from "./routes/system.js";

export function registerRoutes(app: FastifyInstance, db: SqliteDatabase, scheduler: Scheduler, telegram: TelegramService, vault: SecretVault, coverCache: CoverCacheStore): void {
  const services = { app, db, scheduler, telegram, vault, coverCache };
  registerAuthRoutes(services);
  registerCollectionRoutes(services);
  registerSubscriptionRoutes(services);
  registerActivityRoutes(services);
  registerSettingsRoutes(services);
  registerAdminRoutes(services);
  registerSystemRoutes(services);
}
