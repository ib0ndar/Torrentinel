import { config } from "../../../config.js";
import { challengeDetected, TrackerError } from "../errors.js";

export interface BrowserPage {
  body: string;
  url: string;
  status: number;
}

interface SolverSolution {
  response?: string;
  status?: number;
  url?: string;
}

interface SolverResponse {
  status?: string;
  message?: string;
  session?: string;
  sessions?: Array<string | { id?: string }>;
  solution?: SolverSolution;
}

export class FlareSolverrError extends TrackerError {
  constructor(message: string, code: "challenge" | "temporary" = "temporary", cause?: unknown) {
    super(code, message, { trackerKey: "rutracker", retryable: true, cause });
    this.name = "FlareSolverrError";
  }
}

export class FlareSolverrClient {
  private sessionReady = false;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly apiUrl = config.flaresolverrUrl,
    private readonly sessionId = "torrentinel-rutracker",
  ) {}

  get(url: string, signal?: AbortSignal): Promise<BrowserPage> {
    return this.serialized(() => this.getPage(url, signal));
  }

  close(): Promise<void> {
    return this.serialized(async () => {
      if (!this.sessionReady) return;
      try {
        await this.post({ cmd: "sessions.destroy", session: this.sessionId });
      } catch {
        // The resolver may already be stopped during application shutdown.
      } finally {
        this.sessionReady = false;
      }
    });
  }

  private async getPage(url: string, signal?: AbortSignal): Promise<BrowserPage> {
    await this.ensureSession(signal);
    try {
      return await this.requestPage(url, signal);
    } catch (error) {
      if (isMissingSessionError(error)) {
        this.sessionReady = false;
        await this.ensureSession(signal);
        return this.requestPage(url, signal);
      }
      // A first navigation can leave Cloudflare's newly-issued clearance cookie
      // in the persistent browser session even when that response is still the
      // challenge page. Retry once in the same session before surfacing it.
      if (error instanceof TrackerError && error.code === "challenge") {
        return this.requestPage(url, signal);
      }
      throw error;
    }
  }

  private async ensureSession(signal?: AbortSignal): Promise<void> {
    if (this.sessionReady) return;
    const listed = await this.post({ cmd: "sessions.list" }, signal);
    const exists = listed.sessions?.some((session) => (
      typeof session === "string" ? session === this.sessionId : session.id === this.sessionId
    ));
    if (!exists) {
      await this.post({ cmd: "sessions.create", session: this.sessionId, session_ttl_minutes: 120 }, signal);
    }
    this.sessionReady = true;
  }

  private async requestPage(url: string, signal?: AbortSignal): Promise<BrowserPage> {
    const result = await this.post({
      cmd: "request.get",
      url,
      session: this.sessionId,
      session_ttl_minutes: 120,
      maxTimeout: config.flaresolverrTimeoutMs,
      waitInSeconds: 1,
      disableMedia: true,
    }, signal);
    const body = result.solution?.response;
    const status = result.solution?.status;
    if (!body || typeof status !== "number") throw new FlareSolverrError("RuTracker detail resolver returned no page");
    if (status < 200 || status >= 300) throw new FlareSolverrError(`RuTracker detail resolver returned HTTP ${status}`);
    if (challengeDetected(body)) {
      throw new FlareSolverrError("RuTracker verification was not completed by the detail resolver", "challenge");
    }
    return { body, status, url: result.solution?.url || url };
  }

  private async post(payload: Record<string, unknown>, signal?: AbortSignal): Promise<SolverResponse> {
    const timeout = AbortSignal.timeout(config.flaresolverrTimeoutMs + 10_000);
    const combinedSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await fetch(this.apiUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: combinedSignal,
      });
    } catch (error) {
      throw new FlareSolverrError(`RuTracker detail resolver is unavailable: ${errorMessage(error)}`, "temporary", error);
    }

    let result: SolverResponse;
    try {
      result = await response.json() as SolverResponse;
    } catch (error) {
      throw new FlareSolverrError(`RuTracker detail resolver returned HTTP ${response.status} without JSON`, "temporary", error);
    }
    if (!response.ok || result.status !== "ok") {
      throw new FlareSolverrError(`RuTracker detail resolver failed: ${result.message || `HTTP ${response.status}`}`);
    }
    return result;
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}

function isMissingSessionError(error: unknown): boolean {
  return error instanceof Error && /session.+(?:not found|does not exist|doesn't exist|invalid|expired)/i.test(error.message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
