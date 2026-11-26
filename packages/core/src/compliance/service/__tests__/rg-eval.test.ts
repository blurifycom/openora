import { RG_FLAG_THRESHOLD_PCT } from '@openora/core/contracts';
import { describe, expect, it } from 'vitest';
import { isAtThreshold, pendingChangeStatus, thresholdPct } from '../rg-eval.js';

const EFFECTIVE = new Date('2026-03-10T12:00:00.000Z');
const EXPIRES = new Date('2026-03-11T12:00:00.000Z');
const at = (base: Date, deltaMs: number) => new Date(base.getTime() + deltaMs);

describe('thresholdPct', () => {
  it('returns 0 when the limit is zero', () => {
    expect(thresholdPct(50, 0)).toBe(0);
  });

  it('returns 0 when the limit is negative', () => {
    expect(thresholdPct(50, -100)).toBe(0);
  });

  it('returns the percentage of actual against the limit', () => {
    expect(thresholdPct(25, 100)).toBe(25);
    expect(thresholdPct(0, 100)).toBe(0);
    expect(thresholdPct(100, 100)).toBe(100);
  });

  it('returns more than 100 when actual exceeds the limit', () => {
    expect(thresholdPct(150, 100)).toBe(150);
    expect(thresholdPct(101, 100)).toBeGreaterThan(100);
  });
});

describe('isAtThreshold', () => {
  const limit = 100;
  const atFlag = (limit * RG_FLAG_THRESHOLD_PCT) / 100;

  it('is false just below the flag threshold', () => {
    expect(isAtThreshold(atFlag - 1, limit)).toBe(false);
  });

  it('is true exactly at the flag threshold', () => {
    expect(isAtThreshold(atFlag, limit)).toBe(true);
  });

  it('is true above the flag threshold', () => {
    expect(isAtThreshold(atFlag + 1, limit)).toBe(true);
    expect(isAtThreshold(limit * 2, limit)).toBe(true);
  });

  it('is false for a non-positive limit', () => {
    expect(isAtThreshold(1000, 0)).toBe(false);
    expect(isAtThreshold(1000, -1)).toBe(false);
  });
});

describe('pendingChangeStatus', () => {
  it('returns null when there is no pending kind', () => {
    expect(
      pendingChangeStatus(
        { pendingKind: null, pendingEffectiveAt: EFFECTIVE, pendingExpiresAt: EXPIRES },
        EXPIRES,
      ),
    ).toBeNull();
  });

  it('returns null when the pending kind has no effective time', () => {
    expect(
      pendingChangeStatus(
        { pendingKind: 'increase', pendingEffectiveAt: null, pendingExpiresAt: EXPIRES },
        EXPIRES,
      ),
    ).toBeNull();
  });

  it('returns waiting before the effective time', () => {
    expect(
      pendingChangeStatus(
        { pendingKind: 'increase', pendingEffectiveAt: EFFECTIVE, pendingExpiresAt: EXPIRES },
        at(EFFECTIVE, -1),
      ),
    ).toBe('waiting');
  });

  it('returns ready exactly at the effective time', () => {
    expect(
      pendingChangeStatus(
        { pendingKind: 'increase', pendingEffectiveAt: EFFECTIVE, pendingExpiresAt: EXPIRES },
        EFFECTIVE,
      ),
    ).toBe('ready');
  });

  it('returns expired exactly at the expiry time', () => {
    const row = {
      pendingKind: 'increase',
      pendingEffectiveAt: EFFECTIVE,
      pendingExpiresAt: EXPIRES,
    };
    expect(pendingChangeStatus(row, at(EXPIRES, -1))).toBe('ready');
    expect(pendingChangeStatus(row, EXPIRES)).toBe('expired');
  });

  it('returns ready after the effective time when there is no expiry', () => {
    expect(
      pendingChangeStatus(
        { pendingKind: 'increase', pendingEffectiveAt: EFFECTIVE, pendingExpiresAt: null },
        at(EFFECTIVE, 365 * 24 * 3600 * 1000),
      ),
    ).toBe('ready');
  });

  it('prefers expired over ready when both times have passed', () => {
    expect(
      pendingChangeStatus(
        { pendingKind: 'increase', pendingEffectiveAt: EFFECTIVE, pendingExpiresAt: EXPIRES },
        at(EXPIRES, 1000),
      ),
    ).toBe('expired');
  });
});
