// Rate-limiter seam. Abuse-prone routes (auth flows, money mutations) consume
// from this adapter so the throttling backend is swappable: the default binding
// is an in-process fixed-window limiter (zero deps - good for `pnpm dev`, seed
// and tests), process-local so it does NOT coordinate across replicas. Set
// REDIS_URL to bind the shipped Redis reference adapter (distributed fixed-window)
// with zero consumer code; rebind RATE_LIMITER via an overlay for any other backend.
import { createToken, type Token } from './token.js';

export type RateLimitOptions = {
  // Max allowed consumptions per window per key.
  limit: number;
  windowMs: number;
  // What to do when the backing store is unreachable: 'allow' keeps availability
  // (throttling pauses during an outage); 'deny' fails closed for keys where an
  // unthrottled window is worse than a 429 (credential guessing). Default 'allow'.
  // The in-process default is never unavailable, so it ignores this.
  onUnavailable?: 'allow' | 'deny';
};

export type RateLimitResult = {
  allowed: boolean;
  // Milliseconds until the window resets. 0 when allowed.
  retryAfterMs: number;
};

export type RateLimiterAdapter = {
  consume(key: string, opts: RateLimitOptions): Promise<RateLimitResult>;
  reset(key: string): Promise<void>;
};

export const RATE_LIMITER: Token<RateLimiterAdapter> = createToken('RATE_LIMITER');
