import type { TrackerKey } from "../../types.js";

export type TrackerErrorCode =
  | "authentication"
  | "challenge"
  | "rate-limit"
  | "network"
  | "http"
  | "missing"
  | "parse"
  | "temporary"
  | "unsupported";

interface TrackerErrorOptions {
  trackerKey?: TrackerKey;
  status?: number;
  url?: string;
  retryable?: boolean;
  cause?: unknown;
}

export class TrackerError extends Error {
  readonly code: TrackerErrorCode;
  readonly trackerKey?: TrackerKey;
  readonly status?: number;
  readonly url?: string;
  readonly retryable: boolean;

  constructor(code: TrackerErrorCode, message: string, options: TrackerErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "TrackerError";
    this.code = code;
    this.trackerKey = options.trackerKey;
    this.status = options.status;
    this.url = options.url;
    this.retryable = options.retryable ?? ["challenge", "rate-limit", "network", "temporary"].includes(code);
  }
}

export function challengeDetected(body: string): boolean {
  return /<title>\s*(?:Just a moment|Attention Required)/i.test(body)
    || /(?:id|class)=["'][^"']*(?:cf-chl-widget|cf-turnstile|cf-browser-verification|challenge-running|challenge-stage|cf-wrapper)/iu.test(body)
    || /(?:window\.)?_cf_chl_opt\s*=/iu.test(body)
    || /Подтвердите, что вы человек|Выполнение проверки безопасности/iu.test(body);
}
