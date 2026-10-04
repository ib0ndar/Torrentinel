import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readlink, rm, stat, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { dirname, resolve } from "node:path";
import { chromium, type BrowserContext, type Page, type Response } from "patchright";
import { config } from "../../../config.js";
import { bareHostname } from "../../../egress.js";
import type { TrackerKey } from "../../../types.js";
import { challengeDetected, TrackerError } from "../errors.js";
import { startBrowserEgressProxy, type BrowserEgressProxy } from "./browser-egress.js";

const SESSION_TTL_MS = 120 * 60 * 1_000;
const CHALLENGE_POLL_MS = 500;
const CHALLENGE_SETTLE_MS = 1_000;
const NAVIGATION_RETRY_MS = 50;
const PROFILE_SINGLETON_FILES = ["SingletonLock", "SingletonSocket", "SingletonCookie"] as const;

type BrowserContextLauncher = (profileDirectory: string, proxyServer: string) => Promise<BrowserContext>;

export interface IntegratedBrowserOptions {
  launchContext?: BrowserContextLauncher;
  profileRoot?: string;
  timeoutMs?: number;
  trackerKey?: TrackerKey;
  trackerName?: string;
  /** The tracker's own domains; the page may navigate within them and the hosts it was asked to open. */
  allowedHosts?: readonly string[];
}

export interface BrowserPage {
  body: string;
  url: string;
  status: number;
  cookies?: Array<{ name: string; value: string; domain?: string }>;
  userAgent?: string;
}

export interface BrowserFormSubmission {
  pageUrl: string;
  formSelector: string;
  values: Record<string, string>;
}

export class IntegratedBrowserError extends TrackerError {
  constructor(
    message: string,
    code: "challenge" | "temporary" = "temporary",
    trackerKey: TrackerKey = "rutracker",
    cause?: unknown,
  ) {
    super(code, message, { trackerKey, retryable: true, cause });
    this.name = "IntegratedBrowserError";
  }
}

/**
 * Runs tracker browser navigation inside the Torrentinel process. Each logical
 * session gets an isolated persistent Chrome profile so authenticated state,
 * challenge clearance, and the browser fingerprint survive application restarts.
 */
export class IntegratedBrowserClient {
  private context?: BrowserContext;
  private contextCreatedAt = 0;
  private queue: Promise<void> = Promise.resolve();
  private readonly trustedHosts = new Set<string>();
  private readonly guardedPages = new WeakSet<Page>();
  private activePage?: Page;
  private proxy?: BrowserEgressProxy;
  private blockedNavigation?: string;

  constructor(
    private readonly sessionId = "torrentinel-rutracker",
    private readonly options: IntegratedBrowserOptions = {},
  ) {
    for (const host of options.allowedHosts || []) this.trustedHosts.add(host.toLocaleLowerCase("en-US"));
  }

  get(url: string, signal?: AbortSignal): Promise<BrowserPage> {
    this.trust(url);
    return this.serialized(() => this.getPage(url, signal));
  }

  submitForm(submission: BrowserFormSubmission, signal?: AbortSignal): Promise<BrowserPage> {
    this.trust(submission.pageUrl);
    return this.serialized(() => this.submitFormPage(submission, signal));
  }

  close(): Promise<void> {
    return this.serialized(() => this.resetContext());
  }

  private async getPage(url: string, signal?: AbortSignal): Promise<BrowserPage> {
    return this.withContextRetry(
      (context) => this.requestPage(context, url, signal),
      signal,
    );
  }

  private async submitFormPage(
    submission: BrowserFormSubmission,
    signal?: AbortSignal,
  ): Promise<BrowserPage> {
    return this.withContextRetry(
      (context) => this.requestPage(context, submission.pageUrl, signal, async (page, deadline) => {
        await page.goto(submission.pageUrl, {
          waitUntil: "domcontentloaded",
          timeout: remaining(deadline),
        });
        await this.ensureChallengeCleared(page, deadline, signal);
        const form = page.locator(submission.formSelector).first();
        if (await form.count() === 0) {
          throw new Error(`Browser form was not found: ${submission.formSelector}`);
        }
        for (const [name, value] of Object.entries(submission.values)) {
          const field = form.locator(`[name=${JSON.stringify(name)}]`).first();
          if (await field.count() === 0) {
            throw new Error(`Browser form field was not found: ${name}`);
          }
          await field.fill(value, { timeout: remaining(deadline) });
        }
        const submit = form.locator('input[type="submit"], button[type="submit"], button:not([type])').first();
        if (await submit.count() === 0) {
          throw new Error(`Browser form submit control was not found: ${submission.formSelector}`);
        }
        await submit.click({ timeout: remaining(deadline) });
      }),
      signal,
    );
  }

  private async withContextRetry<T>(
    request: (context: BrowserContext) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    signal?.throwIfAborted();
    await this.ensureContext();
    try {
      return await request(this.contextOrThrow());
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (isBrowserClosedError(error)) {
        await this.resetContext();
        await this.ensureContext();
        return request(this.contextOrThrow());
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
      await removeStaleProfileSingletons(profileDirectory);
      await restrictWebRtc(profileDirectory);
      this.proxy = await startBrowserEgressProxy(this.isTrustedHost);
      const context = await (this.options.launchContext || launchContext)(profileDirectory, this.proxy.server);
      // Only the session page may run; windows opened by a page are closed straight away.
      context.on("page", (page) => {
        if (this.activePage && !this.activePage.isClosed() && page !== this.activePage) void page.close().catch(() => undefined);
      });
      this.context = context;
      this.contextCreatedAt = Date.now();
    } catch (error) {
      await this.resetContext();
      throw this.browserError(`could not start: ${errorMessage(error)}`, "temporary", error);
    }
  }

  private async requestPage(
    context: BrowserContext,
    url: string,
    signal?: AbortSignal,
    navigate?: (page: Page, deadline: number) => Promise<void>,
  ): Promise<BrowserPage> {
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
    this.blockedNavigation = undefined;
    const abort = () => void page.close().catch(() => undefined);
    signal?.addEventListener("abort", abort, { once: true });
    const deadline = Date.now() + timeoutMs;

    try {
      if (navigate) await navigate(page, deadline);
      else {
        await page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: remaining(deadline),
        });
      }
      const body = await this.ensureChallengeCleared(page, deadline, signal);
      const status = documentStatus ?? 200;
      if (status < 200 || status >= 300) {
        throw this.browserError(`returned HTTP ${status}`);
      }
      const cookies = (await context.cookies(page.url()))
        .map(({ name, value, domain }) => ({ name, value, domain }));
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
      if (this.blockedNavigation) {
        throw this.browserError(`refused to leave the tracker for ${this.blockedNavigation}`, "temporary", error);
      }
      throw this.browserError(`failed: ${errorMessage(error)}`, "temporary", error);
    } finally {
      signal?.removeEventListener("abort", abort);
      page.off("response", observeDocument);
    }
  }

  private async ensureChallengeCleared(
    page: Page,
    deadline: number,
    signal?: AbortSignal,
  ): Promise<string> {
    await settleChallenge(page, deadline, signal);
    const body = await readPageContent(page, deadline, signal);
    if (challengeDetected(body)) {
      throw this.browserError("verification was not completed", "challenge");
    }
    return body;
  }

  private contextOrThrow(): BrowserContext {
    if (this.context) return this.context;
    throw this.browserError("session is unavailable");
  }

  private browserError(
    message: string,
    code: "challenge" | "temporary" = "temporary",
    cause?: unknown,
  ): IntegratedBrowserError {
    return new IntegratedBrowserError(
      `${this.options.trackerName || "RuTracker"} integrated browser ${message}`,
      code,
      this.options.trackerKey || "rutracker",
      cause,
    );
  }

  private async sessionPage(context: BrowserContext): Promise<Page> {
    const page = (this.activePage && !this.activePage.isClosed() ? this.activePage : undefined)
      || context.pages().find((candidate) => !candidate.isClosed())
      || await context.newPage();
    this.activePage = page;
    await this.guardNavigation(context, page);
    return page;
  }

  private trust(url: string): void {
    try {
      this.trustedHosts.add(bareHostname(new URL(url)));
    } catch {
      // An invalid URL fails later in navigation.
    }
  }

  private readonly isTrustedHost = (hostname: string): boolean => (
    [...this.trustedHosts].some((host) => hostname === host || hostname.endsWith(`.${host}`))
  );

  /**
   * Keeps the top-level page on trusted tracker hosts. Only document requests are paused, through
   * a separate DevTools session rather than Playwright routing, which would turn off Chrome's HTTP
   * cache. Where any request may connect to is decided by the egress proxy.
   */
  private async guardNavigation(context: BrowserContext, page: Page): Promise<void> {
    if (this.guardedPages.has(page)) return;
    const session = await context.newCDPSession(page);
    const { frameTree } = await session.send("Page.getFrameTree");
    const mainFrameId = frameTree.frame.id;
    session.on("Fetch.requestPaused", (event) => {
      const allowed = event.frameId !== mainFrameId || topLevelNavigationAllowed(event.request.url, this.isTrustedHost);
      if (!allowed) this.blockedNavigation = hostOf(event.request.url);
      // An aborted navigation leaves the current page in place; a blocked one would load
      // Chrome's error page afterwards and interrupt the next navigation.
      void (allowed
        ? session.send("Fetch.continueRequest", { requestId: event.requestId })
        : session.send("Fetch.failRequest", { requestId: event.requestId, errorReason: "Aborted" })).catch(() => undefined);
    });
    await session.send("Fetch.enable", { patterns: [{ urlPattern: "*", resourceType: "Document", requestStage: "Request" }] });
    this.guardedPages.add(page);
  }

  private async resetContext(): Promise<void> {
    const context = this.context, proxy = this.proxy;
    this.context = undefined;
    this.proxy = undefined;
    this.activePage = undefined;
    this.contextCreatedAt = 0;
    if (context) {
      try {
        await context.close();
      } catch {
        // Chrome may already have exited after a crash or container shutdown.
      }
    }
    await proxy?.close();
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}

/**
 * Chrome stores its process lock in the persistent profile while the control
 * socket lives in the container's ephemeral /tmp. A clean container stop may
 * still leave the profile symlinks behind. If their socket target is gone,
 * remove only those Chrome singleton entries before launching the profile.
 */
async function removeStaleProfileSingletons(profileDirectory: string): Promise<void> {
  const entries = PROFILE_SINGLETON_FILES.map((name) => resolve(profileDirectory, name));
  const present = await Promise.all(entries.map((entry) => pathEntryExists(entry)));
  if (!present.some(Boolean)) return;

  const socketEntry = resolve(profileDirectory, "SingletonSocket");
  const socketTarget = await linkTarget(socketEntry);
  if (socketTarget && await pathTargetExists(resolve(profileDirectory, socketTarget))) {
    throw new Error("browser profile is already in use by an active Chrome process");
  }

  await Promise.all(entries.map((entry) => rm(entry, { force: true })));
}

async function pathEntryExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
}

async function pathTargetExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
}

async function linkTarget(path: string): Promise<string | undefined> {
  try {
    return await readlink(path);
  } catch (error) {
    if (isMissingPathError(error)) return undefined;
    throw error;
  }
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** A top-level page may only be on a trusted tracker host. */
export function topLevelNavigationAllowed(value: string, isTrustedHost: (hostname: string) => boolean): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (url.protocol === "http:" || url.protocol === "https:") && isTrustedHost(bareHostname(url));
}

/**
 * WebRTC sends UDP directly rather than through the proxy. Full Chrome ignores the command-line
 * switch for this but honours the profile preference behind the WebRtcIPHandlingPolicy policy, which
 * stops UDP that does not go through the proxy, so WebRTC cannot reach local addresses either.
 */
async function restrictWebRtc(profileDirectory: string): Promise<void> {
  const path = resolve(profileDirectory, "Default", "Preferences");
  let preferences: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) preferences = parsed as Record<string, unknown>;
  } catch (error) {
    // Chrome resets an unreadable preferences file itself, so it is replaced rather than kept.
    if (!isMissingPathError(error) && !(error instanceof SyntaxError)) throw error;
  }
  const webrtc = preferences.webrtc && typeof preferences.webrtc === "object" ? preferences.webrtc as Record<string, unknown> : {};
  if (webrtc.ip_handling_policy === "disable_non_proxied_udp") return;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify({ ...preferences, webrtc: { ...webrtc, ip_handling_policy: "disable_non_proxied_udp" } }), { mode: 0o600 });
}

function hostOf(value: string): string {
  try {
    return new URL(value).host;
  } catch {
    return "an invalid address";
  }
}

let sandboxUnavailable = false;
let sandboxReported = false;

/**
 * BROWSER_SANDBOX=auto starts Chrome with its sandbox and falls back only when the environment
 * cannot provide one (for example Docker's default seccomp profile, which blocks the user
 * namespaces Chrome needs). The fallback is logged once; true refuses to run without it.
 */
async function launchContext(profileDirectory: string, proxyServer: string): Promise<BrowserContext> {
  const channel = selectedBrowserChannel();
  const launch = (chromiumSandbox: boolean) => chromium.launchPersistentContext(profileDirectory, {
    ...(channel ? { channel } : {}),
    headless: config.browserHeadless,
    viewport: config.browserHeadless ? { width: 1365, height: 768 } : null,
    serviceWorkers: "allow",
    chromiumSandbox,
    // With a SOCKS5 proxy Chrome resolves no host names itself and also proxies loopback addresses.
    proxy: { server: proxyServer },
    // Pages may not open further windows (window.open fails as if a popup blocker stopped it). The
    // headless shell limits WebRTC through this switch; full Chrome through the profile preference.
    args: ["--block-new-web-contents", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp"],
  });
  if (config.browserSandbox === "false" || (config.browserSandbox === "auto" && sandboxUnavailable)) return launch(false);
  try {
    const context = await launch(true);
    if (!sandboxReported) {
      sandboxReported = true;
      console.info("The integrated browser runs Chrome with its sandbox.");
    }
    return context;
  } catch (error) {
    if (config.browserSandbox === "true" || !/sandbox/iu.test(errorMessage(error))) throw error;
    sandboxUnavailable = true;
    console.warn("The integrated browser's sandbox is unavailable in this environment, so Chrome runs without it. "
      + "See \"Integrated browser sandbox\" in the README to enable it, or set BROWSER_SANDBOX=false to silence this warning.");
    await removeStaleProfileSingletons(profileDirectory);
    return launch(false);
  }
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
