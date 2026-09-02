import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { resolve } from "node:path";
import { chromium, type BrowserContext, type Page, type Response } from "patchright";
import { config } from "../../../config.js";
import { challengeDetected, TrackerError } from "../errors.js";

const SESSION_TTL_MS = 120 * 60 * 1_000;
const CHALLENGE_POLL_MS = 500;
const CHALLENGE_SETTLE_MS = 1_000;
const NAVIGATION_RETRY_MS = 50;

type BrowserContextLauncher = (profileDirectory: string) => Promise<BrowserContext>;

interface IntegratedBrowserOptions {
  launchContext?: BrowserContextLauncher;
  profileRoot?: string;
  timeoutMs?: number;
}

export interface BrowserPage {
  body: string;
  url: string;
  status: number;
  cookies?: Array<{ name: string; value: string }>;
  userAgent?: string;
}

export class IntegratedBrowserError extends TrackerError {
  constructor(message: string, code: "challenge" | "temporary" = "temporary", cause?: unknown) {
    super(code, message, { trackerKey: "rutracker", retryable: true, cause });
    this.name = "IntegratedBrowserError";
  }
}

/**
 * Runs RuTracker browser navigation inside the Torrentinel process. Each logical
 * session gets an isolated persistent Chrome profile so Cloudflare clearance and
 * the browser fingerprint survive both requests and application restarts.
 */
export class IntegratedBrowserClient {
  private context?: BrowserContext;
  private contextCreatedAt = 0;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly sessionId = "torrentinel-rutracker",
    private readonly options: IntegratedBrowserOptions = {},
  ) {}

  get(url: string, signal?: AbortSignal): Promise<BrowserPage> {
    return this.serialized(() => this.getPage(url, signal));
  }

  close(): Promise<void> {
    return this.serialized(() => this.resetContext());
  }

  private async getPage(url: string, signal?: AbortSignal): Promise<BrowserPage> {
    signal?.throwIfAborted();
    await this.ensureContext();
    try {
      return await this.requestPage(url, signal);
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (isBrowserClosedError(error)) {
        await this.resetContext();
        await this.ensureContext();
        return this.requestPage(url, signal);
      }
      throw error;
    }
  }

  private async ensureContext(): Promise<void> {
    if (this.context && Date.now() - this.contextCreatedAt < SESSION_TTL_MS) return;
    await this.resetContext();
    const profileDirectory = resolve(
      this.options.profileRoot || config.browserProfileDir,
      createHash("sha256").update(this.sessionId).digest("hex").slice(0, 24),
    );
    await mkdir(profileDirectory, { recursive: true, mode: 0o700 });
    try {
      this.context = await (this.options.launchContext || launchContext)(profileDirectory);
      this.contextCreatedAt = Date.now();
    } catch (error) {
      await this.resetContext();
      throw new IntegratedBrowserError(`RuTracker integrated browser could not start: ${errorMessage(error)}`, "temporary", error);
    }
  }

  private async requestPage(url: string, signal?: AbortSignal): Promise<BrowserPage> {
    const context = this.context;
    if (!context) throw new IntegratedBrowserError("RuTracker integrated browser session is unavailable");
    const page = await this.sessionPage(context);
    const timeoutMs = this.options.timeoutMs || config.browserTimeoutMs;
    page.setDefaultTimeout(timeoutMs);
    let documentStatus: number | undefined;
    const observeDocument = (response: Response) => {
      if (response.frame() === page.mainFrame() && response.request().resourceType() === "document") {
        documentStatus = response.status();
      }
    };
    page.on("response", observeDocument);
    const abort = () => void page.close().catch(() => undefined);
    signal?.addEventListener("abort", abort, { once: true });
    const deadline = Date.now() + timeoutMs;

    try {
      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: remaining(deadline),
      });
      await settleChallenge(page, deadline, signal);
      const body = await readPageContent(page, deadline, signal);
      if (challengeDetected(body)) {
        throw new IntegratedBrowserError("RuTracker verification was not completed by the integrated browser", "challenge");
      }
      const status = documentStatus ?? 200;
      if (status < 200 || status >= 300) {
        throw new IntegratedBrowserError(`RuTracker integrated browser returned HTTP ${status}`);
      }
      const cookies = (await context.cookies(page.url()))
        .map(({ name, value }) => ({ name, value }));
      const userAgent = await page.evaluate(() => navigator.userAgent);
      return {
        body,
        status,
        url: page.url(),
        cookies,
        userAgent,
      };
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (error instanceof TrackerError) throw error;
      throw new IntegratedBrowserError(`RuTracker integrated browser failed: ${errorMessage(error)}`, "temporary", error);
    } finally {
      signal?.removeEventListener("abort", abort);
      page.off("response", observeDocument);
    }
  }

  private async sessionPage(context: BrowserContext): Promise<Page> {
    const existing = context.pages().find((page) => !page.isClosed());
    return existing || context.newPage();
  }

  private async resetContext(): Promise<void> {
    const context = this.context;
    this.context = undefined;
    this.contextCreatedAt = 0;
    if (!context) return;
    try {
      await context.close();
    } catch {
      // Chrome may already have exited after a crash or container shutdown.
    }
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}

function launchContext(profileDirectory: string): Promise<BrowserContext> {
  const channel = selectedBrowserChannel();
  return chromium.launchPersistentContext(profileDirectory, {
    ...(channel ? { channel } : {}),
    headless: config.browserHeadless,
    viewport: config.browserHeadless ? { width: 1365, height: 768 } : null,
    serviceWorkers: "allow",
  });
}

function selectedBrowserChannel(): string | undefined {
  const configured = config.browserChannel.trim().toLocaleLowerCase("en-US");
  if (configured === "chromium") return undefined;
  if (configured === "auto") return process.arch === "x64" ? "chrome" : undefined;
  return config.browserChannel;
}

async function settleChallenge(page: Page, deadline: number, signal?: AbortSignal): Promise<void> {
  const settleDelay = Math.min(
    CHALLENGE_SETTLE_MS,
    Math.max(1, remaining(deadline) - CHALLENGE_POLL_MS),
  );
  await delay(settleDelay, undefined, { signal });
  let body = await readPageContent(page, deadline, signal);
  if (!challengeDetected(body)) return;

  let clickAttempted = false;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    if (!clickAttempted) clickAttempted = await clickChallengeControl(page);
    await delay(Math.min(CHALLENGE_POLL_MS, remaining(deadline)), undefined, { signal });
    body = await readPageContent(page, deadline, signal);
    if (!challengeDetected(body)) {
      await page.waitForLoadState("domcontentloaded", { timeout: remaining(deadline) }).catch(() => undefined);
      return;
    }
  }
}

async function readPageContent(page: Page, deadline: number, signal?: AbortSignal): Promise<string> {
  while (true) {
    signal?.throwIfAborted();
    try {
      return await page.content();
    } catch (error) {
      if (!isNavigationInProgressError(error) || remaining(deadline) <= 1) throw error;
      await page.waitForLoadState("domcontentloaded", {
        timeout: Math.min(CHALLENGE_SETTLE_MS, remaining(deadline)),
      }).catch(() => undefined);
      if (remaining(deadline) <= 1) throw error;
      await delay(Math.min(NAVIGATION_RETRY_MS, remaining(deadline) - 1), undefined, { signal });
    }
  }
}

async function clickChallengeControl(page: Page): Promise<boolean> {
  const selectors = [
    "input[type='checkbox']",
    "[role='checkbox']",
    ".cf-turnstile",
  ];
  for (const frame of page.frames()) {
    for (const selector of selectors) {
      try {
        const control = frame.locator(selector).first();
        if (!await control.isVisible({ timeout: 250 })) continue;
        const box = await control.boundingBox();
        if (box) {
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 });
          await page.mouse.down();
          await delay(80);
          await page.mouse.up();
        } else {
          await control.click({ timeout: 1_000 });
        }
        return true;
      } catch {
        // Cross-origin and closed-shadow challenge controls may not be exposed.
      }
    }
  }
  return false;
}

function remaining(deadline: number): number {
  return Math.max(1, deadline - Date.now());
}

function isBrowserClosedError(error: unknown): boolean {
  return error instanceof Error && /(?:browser|context|page|target).+(?:closed|crashed|disconnected)/iu.test(error.message);
}

function isNavigationInProgressError(error: unknown): boolean {
  return error instanceof Error && /(?:page is navigating|execution context was destroyed|cannot find context with specified id|most likely because of a navigation)/iu.test(error.message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
