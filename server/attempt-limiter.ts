export interface AttemptRule {
  key: string;
  limit: number;
}

interface Bucket {
  failures: number;
  resetAt: number;
}

/**
 * Counts failed attempts per key in fixed windows. Callers check every rule before doing
 * expensive work (password hashing) and record a failure for each rule afterwards.
 */
export class AttemptLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly windowMs = 15 * 60 * 1_000,
    private readonly now: () => number = Date.now,
    private readonly maximumBuckets = 10_000,
  ) {}

  /** Milliseconds until another attempt is allowed, or 0 when every rule still has room. */
  retryAfterMs(rules: readonly AttemptRule[]): number {
    const now = this.now();
    return Math.max(0, ...rules.map(({ key, limit }) => {
      const bucket = this.buckets.get(key);
      return bucket && bucket.resetAt > now && bucket.failures >= limit ? bucket.resetAt - now : 0;
    }));
  }

  /** Failures recorded for key in its current window. */
  failures(key: string): number {
    const bucket = this.buckets.get(key);
    return bucket && bucket.resetAt > this.now() ? bucket.failures : 0;
  }

  recordFailure(rules: ReadonlyArray<Pick<AttemptRule, "key">>): void {
    const now = this.now();
    for (const { key } of rules) {
      let bucket = this.buckets.get(key);
      if (!bucket || bucket.resetAt <= now) {
        this.buckets.delete(key);
        bucket = { failures: 0, resetAt: now + this.windowMs };
        this.buckets.set(key, bucket);
      }
      bucket.failures += 1;
    }
    this.prune(now);
  }

  reset(keys: readonly string[]): void {
    for (const key of keys) this.buckets.delete(key);
  }

  private prune(now: number): void {
    if (this.buckets.size <= this.maximumBuckets) return;
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
    // Map iteration follows insertion order, so the oldest windows go first.
    for (const key of this.buckets.keys()) {
      if (this.buckets.size <= this.maximumBuckets) break;
      this.buckets.delete(key);
    }
  }
}

export interface SpacingOptions {
  /** Failures in the window before attempts are spaced out. */
  freeFailures: number;
  /** Spacing at freeFailures failures; it doubles with each further failure up to maximumSpacingMs. */
  initialSpacingMs: number;
  maximumSpacingMs: number;
  /** Longest an attempt waits for its turn; later attempts are turned away until there is room. */
  maximumWaitMs: number;
}

export type AttemptTurn = { waitMs: number } | { retryAfterMs: number };

/**
 * Spaces out attempts on one key (an account) once it has collected many failures, instead of
 * blocking it. Each attempt waits for its turn, so the right password still gets through after a
 * short wait, while guesses from any number of addresses are held to one per spacing interval.
 */
export class AttemptSpacer {
  private readonly nextTurns = new Map<string, number>();

  constructor(
    private readonly limiter: AttemptLimiter,
    private readonly options: SpacingOptions,
    private readonly now: () => number = Date.now,
    private readonly maximumKeys = 10_000,
  ) {}

  /**
   * Reserves the next turn for key and says how long to wait for it. When the wait would exceed
   * maximumWaitMs, nothing is reserved and the result says how long until there is room.
   */
  reserve(key: string): AttemptTurn {
    const failures = this.limiter.failures(key);
    if (failures < this.options.freeFailures) return { waitMs: 0 };
    const now = this.now();
    const turn = Math.max(now, this.nextTurns.get(key) ?? now);
    if (turn - now > this.options.maximumWaitMs) return { retryAfterMs: turn - now - this.options.maximumWaitMs };
    const spacing = Math.min(this.options.maximumSpacingMs, this.options.initialSpacingMs * 2 ** (failures - this.options.freeFailures));
    // Re-inserting keeps the map in order of last use, so pruning drops the longest idle keys first.
    this.nextTurns.delete(key);
    this.nextTurns.set(key, turn + spacing);
    this.prune(now);
    return { waitMs: turn - now };
  }

  private prune(now: number): void {
    if (this.nextTurns.size <= this.maximumKeys) return;
    for (const [key, turn] of this.nextTurns) {
      if (turn <= now) this.nextTurns.delete(key);
    }
    for (const key of this.nextTurns.keys()) {
      if (this.nextTurns.size <= this.maximumKeys) break;
      this.nextTurns.delete(key);
    }
  }
}
