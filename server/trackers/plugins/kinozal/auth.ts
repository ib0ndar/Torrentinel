import { createHash } from "node:crypto";
import type { TrackerContext } from "../../core/contracts.js";
import { challengeDetected, TrackerError } from "../../core/errors.js";
import {
  IntegratedBrowserClient,
  type BrowserFormSubmission,
  type BrowserPage,
} from "../../core/transport/browser.js";

const LOGIN_FORM_SELECTOR = 'form[action*="takelogin.php"]';
const DEFAULT_RETRY_BACKOFF_MS = 15 * 60 * 1_000;

export interface KinozalPageSession {
  get(url: string, context: TrackerContext): Promise<BrowserPage>;
  close?(): Promise<void>;
}

export interface KinozalBrowserSession {
  get(url: string, signal?: AbortSignal): Promise<BrowserPage>;
  submitForm(submission: BrowserFormSubmission, signal?: AbortSignal): Promise<BrowserPage>;
  close?(): Promise<void>;
}

export type KinozalBrowserFactory = (sessionId: string) => KinozalBrowserSession;

export interface KinozalSessionOptions {
  now?: () => number;
  retryBackoffMs?: number;
}

interface SessionEntry {
  client: KinozalBrowserSession;
  credentialKey: string;
  authenticated: boolean;
  retryAfter: number;
  lastFailureCode?: string;
}

export class KinozalSessionManager {
  private readonly sessions = new Map<string, SessionEntry>();

  constructor(
    private readonly browserFactory: KinozalBrowserFactory = (sessionId) => (
      new IntegratedBrowserClient(sessionId, {
        trackerKey: "kinozal",
        trackerName: "Kinozal",
      })
    ),
    private readonly options: KinozalSessionOptions = {},
  ) {}

  async get(url: string, context: TrackerContext): Promise<BrowserPage> {
    const entry = await this.entry(context);
    this.rejectDuringBackoff(entry);
    await this.ensureAuthenticated(entry, context);
    let result = await this.request(entry, () => entry.client.get(url, context.signal));
    if (!looksLikeLoginPage(result.body)) return result;

    entry.authenticated = false;
    await this.ensureAuthenticated(entry, context);
    result = await this.request(entry, () => entry.client.get(url, context.signal));
    if (looksLikeLoginPage(result.body)) {
      const error = new TrackerError("authentication", "Kinozal session expired and could not be refreshed", {
        trackerKey: "kinozal",
      });
      this.deferRetry(entry, error);
      throw error;
    }
    return result;
  }

  async close(): Promise<void> {
    const clients = new Set([...this.sessions.values()].map((entry) => entry.client));
    this.sessions.clear();
    await Promise.all([...clients].map(async (client) => client.close?.()));
  }

  private async entry(context: TrackerContext): Promise<SessionEntry> {
    if (!context.username || !context.password) {
      throw new TrackerError("authentication", "Kinozal credentials are not configured", { trackerKey: "kinozal" });
    }
    const origin = new URL(context.baseUrl).origin;
    const credentialKey = createHash("sha256")
      .update(context.username)
      .update("\0")
      .update(context.password)
      .digest("hex");
    const ownerKey = context.userId || credentialKey;
    const sessionKey = createHash("sha256")
      .update(origin)
      .update("\0")
      .update(ownerKey)
      .digest("hex")
      .slice(0, 20);
    let entry = this.sessions.get(sessionKey);
    if (!entry || entry.credentialKey !== credentialKey) {
      await entry?.client.close?.();
      entry = {
        client: this.browserFactory(`torrentinel-kinozal-${sessionKey}`),
        credentialKey,
        authenticated: false,
        retryAfter: 0,
      };
      this.sessions.set(sessionKey, entry);
    }
    return entry;
  }

  private async ensureAuthenticated(entry: SessionEntry, context: TrackerContext): Promise<void> {
    if (entry.authenticated) return;
    this.rejectDuringBackoff(entry);
    try {
      const landing = await entry.client.get(context.baseUrl, context.signal);
      this.rejectChallenge(landing.body);
      if (!looksLikeLoginPage(landing.body)) {
        entry.authenticated = true;
        this.clearRetry(entry);
        return;
      }

      const result = await entry.client.submitForm({
        pageUrl: context.baseUrl,
        formSelector: LOGIN_FORM_SELECTOR,
        values: {
          username: context.username!,
          password: context.password!,
        },
      }, context.signal);
      this.rejectChallenge(result.body);
      if (/Превышен лимит попыток|Попробуйте через \d+ (?:час|минут)/iu.test(result.body)) {
        throw new TrackerError("rate-limit", "Kinozal temporarily blocked additional login attempts", {
          trackerKey: "kinozal",
        });
      }
      if (/Не\s*верно указан пароль|неверн(?:ый|о указан) пароль/iu.test(result.body) || looksLikeLoginPage(result.body)) {
        throw new TrackerError("authentication", "Kinozal authentication failed; verify the configured credentials", {
          trackerKey: "kinozal",
        });
      }
      entry.authenticated = true;
      this.clearRetry(entry);
    } catch (error) {
      entry.authenticated = false;
      this.deferRetry(entry, error);
      throw error;
    }
  }

  private async request(
    entry: SessionEntry,
    operation: () => Promise<BrowserPage>,
  ): Promise<BrowserPage> {
    this.rejectDuringBackoff(entry);
    try {
      const result = await operation();
      this.rejectChallenge(result.body);
      this.clearRetry(entry);
      return result;
    } catch (error) {
      this.deferRetry(entry, error);
      throw error;
    }
  }

  private rejectDuringBackoff(entry: SessionEntry): void {
    const remainingMs = entry.retryAfter - this.now();
    if (remainingMs <= 0) return;
    const failure = entry.lastFailureCode ? ` after a recent ${entry.lastFailureCode} failure` : "";
    throw new TrackerError(
      "rate-limit",
      `Kinozal browser retry is paused for ${Math.ceil(remainingMs / 1_000)} more seconds${failure}`,
      { trackerKey: "kinozal", retryable: true },
    );
  }

  private deferRetry(entry: SessionEntry, error: unknown): void {
    entry.retryAfter = this.now() + (this.options.retryBackoffMs || DEFAULT_RETRY_BACKOFF_MS);
    entry.lastFailureCode = error instanceof TrackerError ? error.code : "temporary";
  }

  private clearRetry(entry: SessionEntry): void {
    entry.retryAfter = 0;
    entry.lastFailureCode = undefined;
  }

  private now(): number {
    return (this.options.now || Date.now)();
  }

  private rejectChallenge(body: string): void {
    if (challengeDetected(body) || /g-recaptcha|hcaptcha|captcha-container/iu.test(body)) {
      throw new TrackerError("challenge", "Kinozal returned an interactive verification challenge", {
        trackerKey: "kinozal",
      });
    }
  }
}

export function looksLikeLoginPage(body: string): boolean {
  return /<form[^>]+(?:takelogin\.php|name=["']?login)/iu.test(body)
    && /name=["']username["']/iu.test(body)
    && /name=["']password["']/iu.test(body);
}
