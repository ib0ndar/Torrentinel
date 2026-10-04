import { config } from "./config.js";
import { createApplication } from "./app.js";

const { app, scheduler, telegram } = await createApplication();
if (config.publicUrl?.startsWith("https:") && !config.sessionCookieSecure) {
  app.log.warn("PUBLIC_URL uses HTTPS but SESSION_COOKIE_SECURE is false; set it to true so session cookies are never sent over plain HTTP.");
}
await app.listen({ host: config.host, port: config.port });
scheduler.start();
await telegram.start();

let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  try {
    await app.close();
    process.exitCode = 0;
  } catch (error) {
    app.log.error(error);
    process.exitCode = 1;
  }
}

process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
