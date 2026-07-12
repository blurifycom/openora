import { ORPCError } from '@orpc/server';
import type {
  RateLimiterAdapter,
  RateLimitOptions,
  RateLimitResult,
} from '@openora/core/contracts';

// Zero-dependency in-process default (set REDIS_URL to bind the distributed Redis
// reference adapter instead). State is a Map keyed by the caller-supplied key; each
// entry is a fixed window (count + resetAt). Expiry is lazy (checked on access) plus
// an unref'd sweep so keys never revisited don't accumulate.
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

/** A 429 (TOO_MANY_REQUESTS) error carrying the client-facing back-off hint in its data. */
export function makeRateLimitError(
  retryAfterMs: number,
): ORPCError<'TOO_MANY_REQUESTS', { retryAfterMs: number }> {
  return new ORPCError('TOO_MANY_REQUESTS', {
    message: 'Too many requests. Please try again later.',
    data: { retryAfterMs },
  });
}

/**
 * Consume one unit for `key`; throw a 429 with retryAfterMs when the limit is exceeded.
 * No-ops when `limiter` is undefined so call sites don't need an optional-guard wrapper.
 */
export async function assertRateLimit(
  limiter: RateLimiterAdapter | undefined,
  key: string,
  opts: RateLimitOptions,
): Promise<void> {
  if (!limiter) {
    return;
  }
  const { allowed, retryAfterMs } = await limiter.consume(key, opts);
  if (!allowed) {
    throw makeRateLimitError(retryAfterMs);
  }
}
