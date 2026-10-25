import { z } from "zod";
import { requireAdmin, requireReadyUser } from "../auth.js";
import { MAX_POLL_INTERVAL_MINUTES, MIN_POLL_INTERVAL_MINUTES } from "../scheduler.js";
import { parse, type RouteServices } from "./shared.js";

export function registerSystemRoutes({ app, db, scheduler }: RouteServices): void {
  // Open to health probes without signing in, so it reveals nothing beyond whether the service and its database answer.
  app.get("/api/health", async () => {
    db.prepare("SELECT 1").get();
    return { status: "ok", database: "ready" };
  });
  app.get("/magnet/:infoHash", async (request, reply) => {
    const params = parse(z.object({ infoHash: z.string().regex(/^(?:[a-f\d]{40}|[a-z2-7]{32})$/i) }), request.params, reply);
    if (!params) return;
    return reply.code(302).header("location", `magnet:?xt=urn:btih:${params.infoHash.toLocaleUpperCase("en-US")}`).send();
  });
  app.get("/api/system/status", { preHandler: requireReadyUser }, async () => ({ scheduler: scheduler.status(), intervalMinutes: scheduler.pollIntervalMinutes(), discoveryHealth: scheduler.discoveryHealth() }));
  app.post("/api/system/poll", { preHandler: requireAdmin }, async () => ({ scheduler: await scheduler.run("admin") }));
  app.put("/api/admin/settings/poll-interval", { preHandler: requireAdmin }, async (request, reply) => {
    const input = parse(z.object({ minutes: z.number().int().min(MIN_POLL_INTERVAL_MINUTES).max(MAX_POLL_INTERVAL_MINUTES) }), request.body, reply);
    if (!input) return;
    const schedulerStatus = scheduler.setPollIntervalMinutes(input.minutes);
    return { intervalMinutes: scheduler.pollIntervalMinutes(), scheduler: schedulerStatus, discoveryHealth: scheduler.discoveryHealth() };
  });
}
