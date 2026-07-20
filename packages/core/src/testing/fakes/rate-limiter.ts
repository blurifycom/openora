import type {
  RateLimiterAdapter,
  RateLimitOptions,
  RateLimitResult,
} from '@openora/core/contracts';

// Zero-dependency test-only double for `RATE_LIMITER` (production auto-binds
// RedisRateLimiter on REDIS_URL - see `assertDurableSeamsBound`). State is a Map
// keyed by the caller-supplied key; each entry is a fixed window (count + resetAt).
// Expiry is lazy (checked on access) plus an unref'd sweep so keys never revisited
// don't accumulate.
//
// ponytail: fixed-window (not sliding) - a burst can straddle a window boundary
// and briefly allow up to 2x limit. Fine for brute-force/abuse throttling; use a
// sliding algorithm if exactness matters.

type Window = { count: number; resetAt: number };

const SWEEP_INTERVAL_MS = 60_000;

export class InProcessRateLimiter implements RateLimiterAdapter {
  private readonly windows = new Map<string, Window>();
  private readonly sweeper: ReturnType<typeof setInterval>;

  constructor() {
    this.sweeper = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    this.sweeper.unref?.();
  }

  consume(key: string, opts: RateLimitOptions): Promise<RateLimitResult> {
    const now = Date.now();
    const existing = this.windows.get(key);

    if (!existing || now >= existing.resetAt) {
      this.windows.set(key, { count: 1, resetAt: now + opts.windowMs });
      return Promise.resolve({ allowed: true, retryAfterMs: 0 });
    }

    if (existing.count < opts.limit) {
      existing.count += 1;
      return Promise.resolve({ allowed: true, retryAfterMs: 0 });
    }

    return Promise.resolve({ allowed: false, retryAfterMs: existing.resetAt - now });
  }

  reset(key: string): Promise<void> {
    this.windows.delete(key);
    return Promise.resolve();
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, window] of this.windows) {
      if (now >= window.resetAt) {
        this.windows.delete(key);
      }
    }
  }

  close(): void {
    clearInterval(this.sweeper);
    this.windows.clear();
  }
}
