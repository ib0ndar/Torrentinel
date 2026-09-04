import { challengeDetected, TrackerError } from "../../core/errors.js";
import { IntegratedBrowserClient, type BrowserPage } from "../../core/transport/browser.js";
import type { HttpResult } from "../../core/transport/http.js";
import { CookieSession } from "../../core/transport/http.js";
import type { TrackerContext } from "../../core/contracts.js";

export interface RutorHttpSession {
  get(url: string, signal?: AbortSignal): Promise<HttpResult>;
  seedCookies(cookies: Array<{ name: string; value: string }>, userAgent?: string): void;
}

export interface RutorBrowserSession {
  get(url: string, signal?: AbortSignal): Promise<BrowserPage>;
  close?(): Promise<void>;
}

interface RutorSession {
  http: RutorHttpSession;
  browser?: RutorBrowserSession;
}

export class RutorTransport {
  private readonly sessions = new Map<string, RutorSession>();

  constructor(
    private readonly httpFactory: () => RutorHttpSession = () => new CookieSession(),
    private readonly browserFactory: (sessionId: string) => RutorBrowserSession = (sessionId) => (
      new IntegratedBrowserClient(sessionId, {
        trackerKey: "rutor",
        trackerName: "Rutor",
      })
    ),
  ) {}

  async get(url: string, context: TrackerContext): Promise<HttpResult> {
    const origin = new URL(context.baseUrl).origin;
    const session = this.sessionFor(origin);
    try {
      return this.validate(await session.http.get(url, context.signal));
    } catch (error) {
      if (!(error instanceof TrackerError) || error.code !== "challenge") throw error;
      return this.getThroughBrowser(session, origin, url, context.signal);
    }
  }

  async close(): Promise<void> {
    const browsers = [...this.sessions.values()].flatMap((session) => (
      session.browser ? [session.browser] : []
    ));
    this.sessions.clear();
    await Promise.all(browsers.map(async (browser) => browser.close?.()));
  }

  private sessionFor(origin: string): RutorSession {
    let session = this.sessions.get(origin);
    if (!session) {
      session = { http: this.httpFactory() };
      this.sessions.set(origin, session);
    }
    return session;
  }

  private async getThroughBrowser(
    session: RutorSession,
    origin: string,
    url: string,
    signal?: AbortSignal,
  ): Promise<HttpResult> {
    session.browser ||= this.browserFactory(`torrentinel-rutor-${new URL(origin).host}`);
    const page = await session.browser.get(url, signal);
    if (challengeDetected(page.body)) {
      throw new TrackerError("challenge", "Rutor returned an interactive verification challenge", { trackerKey: "rutor" });
    }
    if (page.cookies || page.userAgent) {
      session.http.seedCookies(page.cookies || [], page.userAgent);
    }
    return this.validate({
      body: page.body,
      status: page.status,
      url: page.url,
      headers: new Headers(),
    });
  }

  private validate(result: HttpResult): HttpResult {
    if (challengeDetected(result.body)) {
      throw new TrackerError("challenge", "Rutor returned an interactive verification challenge", { trackerKey: "rutor" });
    }
    if (rutorMissing(result)) {
      throw new TrackerError("missing", "Rutor reports that this torrent no longer exists", {
        trackerKey: "rutor",
        status: result.status,
        url: result.url,
      });
    }
    return result;
  }
}

export function rutorMissing(result: HttpResult): boolean {
  const path = new URL(result.url).pathname.toLocaleLowerCase("en-US");
  return path === "/d.php"
    || /<h1[^>]*>\s*Раздача не существует!\s*<\/h1>/iu.test(result.body)
    || /<title[^>]*>[^<]*Раздача не существует!/iu.test(result.body);
}
