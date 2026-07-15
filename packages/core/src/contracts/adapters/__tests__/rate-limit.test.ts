import { describe, it, expect } from 'vitest';
import { RATE_LIMIT_KEYS, makeRateLimitKey } from '../rate-limit.js';

describe('makeRateLimitKey', () => {
  it('joins a registered prefix with the id', () => {
    expect(makeRateLimitKey(RATE_LIMIT_KEYS.PASSWORD_RESET, 'a@b.dev')).toBe('pwreset:a@b.dev');
    expect(makeRateLimitKey(RATE_LIMIT_KEYS.PASSWORD_RESET_VERIFY, 'a@b.dev')).toBe(
      'pwreset-verify:a@b.dev',
    );
    expect(makeRateLimitKey(RATE_LIMIT_KEYS.LOGIN, 'u1')).toBe('login:u1');
  });

  it('does not normalize the id (callers own normalization)', () => {
    expect(makeRateLimitKey(RATE_LIMIT_KEYS.PASSWORD_RESET_REQUEST, 'A@B.DEV')).toBe(
      'pwreset-req:A@B.DEV',
    );
  });
});
