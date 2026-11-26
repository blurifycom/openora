import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  computeLockoutTier,
  createAccountLockedError,
  hasFailedLoginWindowExpired,
  isActiveLockout,
  makeLoginSecurityState,
} from '../lockout-policy.service.js';

const NOW = Date.parse('2026-06-10T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const ago = (ms: number) => new Date(NOW - ms);

describe('isActiveLockout', () => {
  it.each([
    ['null', null, false],
    ['undefined', undefined, false],
    ['1ms in the future', new Date(NOW + 1), true],
    ['exactly now', new Date(NOW), false],
    ['1ms in the past', new Date(NOW - 1), false],
  ] as const)('lockoutUntil %s is %s', (_name, until, expected) => {
    expect(isActiveLockout(until, NOW)).toBe(expected);
  });
});

describe('hasFailedLoginWindowExpired', () => {
  it.each([
    ['1ms inside the 24h window', ago(DAY - 1), false],
    ['exactly 24h old', ago(DAY), true],
    ['1ms past 24h', ago(DAY + 1), true],
    ['just now', ago(0), false],
  ] as const)('last failure %s -> expired %s', (_name, last, expected) => {
    expect(hasFailedLoginWindowExpired(last, null, NOW)).toBe(expected);
  });

  it('never expires without any failure timestamp', () => {
    expect(hasFailedLoginWindowExpired(null, null, NOW)).toBe(false);
    expect(hasFailedLoginWindowExpired(undefined, undefined, NOW)).toBe(false);
  });

  it('falls back to the last lockout when there is no last failure', () => {
    expect(hasFailedLoginWindowExpired(null, ago(DAY), NOW)).toBe(true);
    expect(hasFailedLoginWindowExpired(null, ago(DAY - 1), NOW)).toBe(false);
  });

  it('prefers the last failure over the fallback lockout', () => {
    expect(hasFailedLoginWindowExpired(ago(1000), ago(DAY * 3), NOW)).toBe(false);
    expect(hasFailedLoginWindowExpired(ago(DAY * 3), ago(1000), NOW)).toBe(true);
  });
});

describe('computeLockoutTier', () => {
  const base = { lastFailedLoginAt: ago(1000), nowMs: NOW };

  it.each([
    [0, 1, 60_000],
    [1, 2, 5 * 60_000],
    [2, 3, 15 * 60_000],
    [3, 4, 15 * 60_000],
    [10, 11, 15 * 60_000],
  ])('lockoutCount %i within the window is tier %i lasting %ims', (lockoutCount, tier, ms) => {
    expect(computeLockoutTier({ ...base, lockoutCount })).toEqual({ tier, durationMs: ms });
  });

  it('resets to tier 1 when the last failure is exactly 24h old', () => {
    expect(
      computeLockoutTier({ lockoutCount: 5, lastFailedLoginAt: ago(DAY), nowMs: NOW }),
    ).toEqual({ tier: 1, durationMs: 60_000 });
  });

  it('keeps escalating 1ms before the window closes', () => {
    expect(
      computeLockoutTier({ lockoutCount: 1, lastFailedLoginAt: ago(DAY - 1), nowMs: NOW }),
    ).toEqual({ tier: 2, durationMs: 5 * 60_000 });
  });

  it('resets to tier 1 with no failure timestamp at all', () => {
    expect(computeLockoutTier({ lockoutCount: 4, lastFailedLoginAt: null, nowMs: NOW })).toEqual({
      tier: 1,
      durationMs: 60_000,
    });
  });

  it('uses the fallback lockout time when the last failure is missing', () => {
    expect(
      computeLockoutTier({
        lockoutCount: 1,
        lastFailedLoginAt: null,
        fallbackLastLockoutAt: ago(1000),
        nowMs: NOW,
      }),
    ).toEqual({ tier: 2, durationMs: 5 * 60_000 });
  });

  it('never lets the duration shrink as the lockout count grows', () => {
    fc.assert(
      fc.property(fc.nat(50), (count) => {
        const lower = computeLockoutTier({ ...base, lockoutCount: count });
        const higher = computeLockoutTier({ ...base, lockoutCount: count + 1 });
        expect(higher.durationMs).toBeGreaterThanOrEqual(lower.durationMs);
        expect(higher.tier).toBe(lower.tier + 1);
      }),
    );
  });

  it('caps every duration at 15 minutes', () => {
    fc.assert(
      fc.property(fc.nat(1000), fc.nat(2 * DAY), (count, age) => {
        const { durationMs } = computeLockoutTier({
          lockoutCount: count,
          lastFailedLoginAt: ago(age),
          nowMs: NOW,
        });
        expect(durationMs).toBeLessThanOrEqual(15 * 60_000);
        expect(durationMs).toBeGreaterThanOrEqual(60_000);
      }),
    );
  });
});

describe('makeLoginSecurityState', () => {
  it.each([
    [0, 5],
    [3, 2],
    [5, 0],
    [9, 0],
  ])('%i failures with a limit of 5 leave %i attempts', (failedLoginAttempts, remaining) => {
    expect(makeLoginSecurityState({ failedLoginAttempts, lockoutUntil: null, nowMs: NOW })).toEqual(
      {
        attemptsRemaining: remaining,
        lockoutUntil: null,
      },
    );
  });

  it('honours a custom attempt limit', () => {
    expect(
      makeLoginSecurityState({
        failedLoginAttempts: 1,
        maxAttempts: 3,
        lockoutUntil: null,
        nowMs: NOW,
      }).attemptsRemaining,
    ).toBe(2);
  });

  it('reports zero attempts and the ISO deadline during an active lockout', () => {
    const until = new Date(NOW + 1);
    expect(
      makeLoginSecurityState({ failedLoginAttempts: 1, lockoutUntil: until, nowMs: NOW }),
    ).toEqual({ attemptsRemaining: 0, lockoutUntil: until.toISOString() });
  });

  it('treats a lockout ending exactly now as over', () => {
    expect(
      makeLoginSecurityState({ failedLoginAttempts: 2, lockoutUntil: new Date(NOW), nowMs: NOW }),
    ).toEqual({ attemptsRemaining: 3, lockoutUntil: null });
  });

  it('never reports negative attempts', () => {
    fc.assert(
      fc.property(fc.nat(100), fc.integer({ min: 1, max: 20 }), (failed, max) => {
        const state = makeLoginSecurityState({
          failedLoginAttempts: failed,
          maxAttempts: max,
          lockoutUntil: null,
          nowMs: NOW,
        });
        expect(state.attemptsRemaining).toBeGreaterThanOrEqual(0);
        expect(state.attemptsRemaining).toBeLessThanOrEqual(max);
      }),
    );
  });
});

describe('createAccountLockedError', () => {
  it('carries the ACCOUNT_LOCKED code, zero attempts and the ISO deadline', () => {
    const until = new Date('2026-06-10T12:15:00.000Z');
    const error = createAccountLockedError(until);
    expect(error.code).toBe('UNAUTHORIZED');
    expect(error.data).toEqual({
      code: 'ACCOUNT_LOCKED',
      attemptsRemaining: 0,
      lockoutUntil: '2026-06-10T12:15:00.000Z',
    });
  });
});
