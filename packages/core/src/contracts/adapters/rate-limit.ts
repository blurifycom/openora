// Rate-limiter seam. Abuse-prone routes (auth flows, money mutations) consume
// from this adapter so the throttling backend is swappable: the default binding
// is an in-process fixed-window limiter (zero deps - good for `pnpm dev`, seed
// and tests), process-local so it does NOT coordinate across replicas. Set
// REDIS_URL to bind the shipped Redis reference adapter (distributed fixed-window)
// with zero consumer code; rebind RATE_LIMITER via an overlay for any other backend.
import { createToken, type Token } from './token.js';

export const RATE_LIMIT_KEYS = {
  REGISTER: 'register',
  LOGIN: 'login',
  ENABLE_2FA: 'enable2fa',
  VERIFY_2FA: 'verify2fa',
  DISABLE_2FA: 'disable2fa',
  PASSWORD_RESET_REQUEST: 'pwreset-req',
  PASSWORD_RESET_VERIFY: 'pwreset-verify',
  PASSWORD_RESET: 'pwreset',
  CHANGE_PASSWORD: 'change-password',
  EMAIL_VERIFICATION: 'email-verify',
  VERIFY_EMAIL: 'verify-email',
  WALLET_MUTATION: 'wallet-mutation',
  CHAT_ROOM_JOIN: 'chat-room-join',
  CHAT_SEND: 'chat-send',
  ACCESS_DENIED_REPORT: 'access-denied-report',
} as const;

export type RateLimitKeyPrefix = (typeof RATE_LIMIT_KEYS)[keyof typeof RATE_LIMIT_KEYS];

export type RateLimitKey = `${RateLimitKeyPrefix}:${string}`;

export function makeRateLimitKey(prefix: RateLimitKeyPrefix, id: string): RateLimitKey {
  return `${prefix}:${id}`;
}

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

export type RateLimiterAdapter<Key extends string = string> = {
  consume(key: Key, opts: RateLimitOptions): Promise<RateLimitResult>;
  reset(key: Key): Promise<void>;
};

export const RATE_LIMITER: Token<RateLimiterAdapter<RateLimitKey>> = createToken('RATE_LIMITER');
