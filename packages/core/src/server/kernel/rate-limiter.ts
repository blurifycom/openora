import { ORPCError } from '@orpc/server';
import type { RateLimiterAdapter, RateLimitOptions } from '@openora/core/contracts';

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
export async function assertRateLimit<K extends string = string>(
  limiter: RateLimiterAdapter<K> | undefined,
  key: K,
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
