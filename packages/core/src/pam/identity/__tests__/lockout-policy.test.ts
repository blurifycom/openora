import { describe, expect, it } from 'vitest';
import {
  computeLockoutTier,
  hasFailedLoginWindowExpired,
  isActiveLockout,
  makeLoginSecurityState,
} from '../service/lockout-policy.service.js';

const DAY = 24 * 60 * 60 * 1000;
const MINUTE = 60_000;
const NOW = Date.parse('2026-06-01T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms);

describe('computeLockoutTier', () => {
  const recent = ago(1000);

  it('the first lockout is tier 1 and lasts one minute', () => {
    expect(computeLockoutTier({ lockoutCount: 0, lastFailedLoginAt: recent, nowMs: NOW })).toEqual({
      tier: 1,
      durationMs: MINUTE,
    });
  });

  it('the second lockout within 24 hours is tier 2 and lasts five minutes', () => {
    expect(computeLockoutTier({ lockoutCount: 1, lastFailedLoginAt: recent, nowMs: NOW })).toEqual({
      tier: 2,
      durationMs: 5 * MINUTE,
    });
  });

  it('the third lockout within 24 hours is tier 3 and lasts fifteen minutes', () => {
    expect(computeLockoutTier({ lockoutCount: 2, lastFailedLoginAt: recent, nowMs: NOW })).toEqual({
      tier: 3,
      durationMs: 15 * MINUTE,
    });
  });

  it('a fourth and later lockout stays at fifteen minutes', () => {
    for (const lockoutCount of [3, 4, 10]) {
      const result = computeLockoutTier({ lockoutCount, lastFailedLoginAt: recent, nowMs: NOW });
      expect(result.tier).toBe(lockoutCount + 1);
      expect(result.durationMs).toBe(15 * MINUTE);
    }
  });

  it('a last failure older than 24 hours resets the tier to 1', () => {
    expect(
      computeLockoutTier({ lockoutCount: 5, lastFailedLoginAt: ago(DAY + 1), nowMs: NOW }),
    ).toEqual({ tier: 1, durationMs: MINUTE });
  });

  it('a last failure exactly 24 hours ago resets the tier to 1', () => {
    expect(
      computeLockoutTier({ lockoutCount: 5, lastFailedLoginAt: ago(DAY), nowMs: NOW }).tier,
    ).toBe(1);
    expect(
      computeLockoutTier({ lockoutCount: 5, lastFailedLoginAt: ago(DAY - 1), nowMs: NOW }).tier,
    ).toBe(6);
  });

  it('a missing last failure falls back to the last lockout time', () => {
    expect(
      computeLockoutTier({
        lockoutCount: 1,
        lastFailedLoginAt: null,
        fallbackLastLockoutAt: recent,
        nowMs: NOW,
      }).tier,
    ).toBe(2);
    expect(
      computeLockoutTier({
        lockoutCount: 1,
        lastFailedLoginAt: null,
        fallbackLastLockoutAt: ago(DAY),
        nowMs: NOW,
      }).tier,
    ).toBe(1);
  });

  it('with no failure and no lockout time the tier is 1', () => {
    expect(computeLockoutTier({ lockoutCount: 4, lastFailedLoginAt: null, nowMs: NOW })).toEqual({
      tier: 1,
      durationMs: MINUTE,
    });
  });
});

describe('isActiveLockout', () => {
  it('a null or undefined lockout is not active', () => {
    expect(isActiveLockout(null, NOW)).toBe(false);
    expect(isActiveLockout(undefined, NOW)).toBe(false);
  });

  it('a lockout in the future is active', () => {
    expect(isActiveLockout(new Date(NOW + 1), NOW)).toBe(true);
  });

  it('a lockout equal to now is not active', () => {
    expect(isActiveLockout(new Date(NOW), NOW)).toBe(false);
    expect(isActiveLockout(new Date(NOW - 1), NOW)).toBe(false);
  });
});

describe('hasFailedLoginWindowExpired', () => {
  it('no failure time and no fallback is not expired', () => {
    expect(hasFailedLoginWindowExpired(null, null, NOW)).toBe(false);
    expect(hasFailedLoginWindowExpired(undefined, undefined, NOW)).toBe(false);
  });

  it('a failure under 24 hours ago is not expired', () => {
    expect(hasFailedLoginWindowExpired(ago(DAY - 1), null, NOW)).toBe(false);
  });

  it('a failure 24 hours ago or older is expired', () => {
    expect(hasFailedLoginWindowExpired(ago(DAY), null, NOW)).toBe(true);
    expect(hasFailedLoginWindowExpired(ago(DAY + 1), null, NOW)).toBe(true);
  });

  it('the fallback lockout time is used when there is no failure time', () => {
    expect(hasFailedLoginWindowExpired(null, ago(DAY), NOW)).toBe(true);
    expect(hasFailedLoginWindowExpired(null, ago(DAY - 1), NOW)).toBe(false);
    expect(hasFailedLoginWindowExpired(ago(1), ago(DAY * 2), NOW)).toBe(false);
  });
});

describe('makeLoginSecurityState', () => {
  it('reports the attempts remaining below the maximum', () => {
    expect(
      makeLoginSecurityState({ failedLoginAttempts: 2, lockoutUntil: null, nowMs: NOW }),
    ).toEqual({ attemptsRemaining: 3, lockoutUntil: null });
    expect(
      makeLoginSecurityState({
        failedLoginAttempts: 2,
        maxAttempts: 10,
        lockoutUntil: null,
        nowMs: NOW,
      }).attemptsRemaining,
    ).toBe(8);
  });

  it('reports one attempt one under the maximum and none at the maximum', () => {
    const remaining = (failedLoginAttempts: number) =>
      makeLoginSecurityState({ failedLoginAttempts, lockoutUntil: null, nowMs: NOW })
        .attemptsRemaining;
    expect(remaining(4)).toBe(1);
    expect(remaining(5)).toBe(0);
  });

  it('never reports negative attempts remaining', () => {
    expect(
      makeLoginSecurityState({ failedLoginAttempts: 9, lockoutUntil: null, nowMs: NOW })
        .attemptsRemaining,
    ).toBe(0);
  });

  it('an active lockout reports zero attempts and the expiry', () => {
    const until = new Date(NOW + MINUTE);
    expect(
      makeLoginSecurityState({ failedLoginAttempts: 1, lockoutUntil: until, nowMs: NOW }),
    ).toEqual({ attemptsRemaining: 0, lockoutUntil: until.toISOString() });
  });

  it('an expired lockout reports no expiry and the remaining attempts', () => {
    expect(
      makeLoginSecurityState({
        failedLoginAttempts: 1,
        lockoutUntil: new Date(NOW),
        nowMs: NOW,
      }),
    ).toEqual({ attemptsRemaining: 4, lockoutUntil: null });
  });
});
