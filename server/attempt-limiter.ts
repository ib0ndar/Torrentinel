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

  recordFailure(rules: readonly AttemptRule[]): void {
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
