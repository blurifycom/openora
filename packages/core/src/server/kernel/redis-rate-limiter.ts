import type {
  RateLimiterAdapter,
  RateLimitOptions,
  RateLimitResult,
} from '@openora/core/contracts';
import type { RedisClient } from './redis-client.js';
import { createLogger } from './logger.js';

const PREFIX = 'rl:';

// Fixed-window counter in one atomic round-trip: INCR the window, set the expiry
// only on the first hit (so the window runs from the first request, not each one),
// return the count and remaining TTL together. Atomic under concurrency - two
// replicas can't both read a stale count and slip past the limit.
//
// ponytail: fixed-window (not sliding), same ceiling as the in-process default - a
// burst straddling a boundary can briefly allow up to 2x limit. Fine for
// brute-force throttling; swap the script for a sliding window if exactness matters.
const CONSUME_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
return { count, redis.call('PTTL', KEYS[1]) }
`;

/**
 * Redis-backed `RATE_LIMITER`, auto-bound by `createApp` when `REDIS_URL` is
 * set - a fixed-window counter, incremented and expiry-set in one atomic Lua
 * round-trip so concurrent replicas can't both read a stale count and slip
 * past the limit. On a backend error/unreachable client it fails OPEN
 * (allows the request) by default; callers that pass `onUnavailable: 'deny'`
 * (credential-guessing surfaces, where an unthrottled window is worse than a
 * false-positive 429) fail CLOSED instead. Never logs the raw key - it can
 * embed a token or email (`pwreset:<token>`, `login:<email>`) - only the
 * prefix before the first `:` is recorded.
 */
export class RedisRateLimiter implements RateLimiterAdapter {
  private readonly logger = createLogger('redis-rate-limiter');

  constructor(private readonly client: RedisClient) {}

  async consume(key: string, opts: RateLimitOptions): Promise<RateLimitResult> {
    if (!this.client.isReady) {
      return this.unavailable(opts, { keyPrefix: key.split(':')[0] });
    }
    try {
      const reply = await this.client.eval(CONSUME_SCRIPT, {
        keys: [PREFIX + key],
        arguments: [String(opts.windowMs)],
      });
      const [countRaw, pttlRaw] = Array.isArray(reply) ? reply : [];
      const count = Number(countRaw);
      const pttl = Number(pttlRaw);
      const allowed = count <= opts.limit;
      return { allowed, retryAfterMs: allowed ? 0 : Math.max(0, pttl) };
    } catch (err) {
      return this.unavailable(opts, { keyPrefix: key.split(':')[0], err });
    }
  }

  // Backend unreachable: fail-open by default to keep availability (throttling pauses
  // during an outage); fail-closed for keys that opt into 'deny' where an unthrottled
  // window is worse than a 429 (credential guessing).
  // Never log the raw key - it embeds tokens/emails (pwreset:<token>, login:<email>);
  // only the prefix before the first ':' is safe to record.
  private unavailable(opts: RateLimitOptions, ctx: Record<string, unknown>): RateLimitResult {
    this.logger.warn(
      { ...ctx, onUnavailable: opts.onUnavailable ?? 'allow' },
      'rate limiter backend unavailable',
    );
    if (opts.onUnavailable === 'deny') {
      return { allowed: false, retryAfterMs: opts.windowMs };
    }
    return { allowed: true, retryAfterMs: 0 };
  }
}
