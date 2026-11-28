import { ORPCError } from '@orpc/server';
import type { RateLimiterAdapter, RateLimitOptions } from '@openora/core/contracts';

export function makeRateLimitError(
  retryAfterMs: number,
): ORPCError<'TOO_MANY_REQUESTS', { retryAfterMs: number }> {
  return new ORPCError('TOO_MANY_REQUESTS', {
    message: 'Too many requests. Please try again later.',
    data: { retryAfterMs },
  });
}

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
