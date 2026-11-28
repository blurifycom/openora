import type {
  RateLimiterAdapter,
  RateLimitOptions,
  RateLimitResult,
} from '@openora/core/contracts';
import type { RedisClient } from './redis-client.js';
import { createLogger } from './logger.js';

const PREFIX = 'rl:';

const CONSUME_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
return { count, redis.call('PTTL', KEYS[1]) }
`;

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

  async reset(key: string): Promise<void> {
    if (!this.client.isReady) {
      return;
    }
    try {
      await this.client.del(PREFIX + key);
    } catch (err) {
      this.logger.warn({ keyPrefix: key.split(':')[0], err }, 'rate limiter reset failed');
    }
  }

  private unavailable(opts: RateLimitOptions, ctx: Record<string, unknown>): RateLimitResult {
    this.logger.warn(
      { ...ctx, onUnavailable: opts.onUnavailable ?? 'allow' },
      'rate limiter backend unavailable',
    );
    if (opts.onUnavailable === 'deny') {
      return { allowed: false, retryAfterMs: opts.windowMs, unavailable: true };
    }
    return { allowed: true, retryAfterMs: 0, unavailable: true };
  }
}
