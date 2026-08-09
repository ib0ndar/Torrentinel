import { config } from "./config.js";
import { createApplication } from "./app.js";

const { app, scheduler, telegram } = await createApplication();
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
