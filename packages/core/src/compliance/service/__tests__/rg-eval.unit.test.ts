import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { RG_FLAG_THRESHOLD_PCT } from '@openora/core/contracts';
import { isAtThreshold, pendingChangeStatus, thresholdPct } from '../rg-eval.js';

describe('thresholdPct', () => {
  it.each([
    [0, 0, 0],
    [50, 0, 0],
    [50, -10, 0],
    [0, 100, 0],
    [50, 100, 50],
    [100, 100, 100],
    [150, 100, 150],
  ])('thresholdPct(%d, %d) = %d', (actual, limit, expected) => {
    expect(thresholdPct(actual, limit)).toBe(expected);
  });

  it('is always 0 for a non-positive limit', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 1e12, noNaN: true }),
        fc.double({ min: -1e12, max: 0, noNaN: true }),
        (actual, limit) => thresholdPct(actual, limit) === 0,
      ),
    );
  });
});

describe('isAtThreshold', () => {
  it.each([
    [0, 0, false],
    [1000, 0, false],
    [79, 100, false],
    [RG_FLAG_THRESHOLD_PCT, 100, true],
    [81, 100, true],
    [100, 100, true],
    [400, 500, true],
    [399, 500, false],
  ])('isAtThreshold(%d, %d) = %s', (actual, limit, expected) => {
    expect(isAtThreshold(actual, limit)).toBe(expected);
  });

  it('is monotonic in spent', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.integer({ min: 0, max: 2_000_000 }),
        fc.integer({ min: 0, max: 2_000_000 }),
        (limit, a, b) => {
          const [low, high] = a <= b ? [a, b] : [b, a];
          return !isAtThreshold(low, limit) || isAtThreshold(high, limit);
        },
      ),
    );
  });
});

describe('pendingChangeStatus', () => {
  const effectiveAt = new Date('2026-01-10T12:00:00.000Z');
  const expiresAt = new Date('2026-01-17T12:00:00.000Z');
  const row = (
    over: Partial<{
      pendingKind: string | null;
      pendingEffectiveAt: Date | null;
      pendingExpiresAt: Date | null;
    }> = {},
  ) => ({
    pendingKind: 'increase',
    pendingEffectiveAt: effectiveAt,
    pendingExpiresAt: expiresAt,
    ...over,
  });
  const at = (offsetMs: number, base: Date) => new Date(base.getTime() + offsetMs);

  it('is null without a pending kind', () => {
    expect(pendingChangeStatus(row({ pendingKind: null }), effectiveAt)).toBeNull();
  });

  it('is null without an effective date', () => {
    expect(pendingChangeStatus(row({ pendingEffectiveAt: null }), effectiveAt)).toBeNull();
  });

  it('is waiting 1ms before effectiveAt', () => {
    expect(pendingChangeStatus(row(), at(-1, effectiveAt))).toBe('waiting');
  });

  it('is ready at effectiveAt to the exact millisecond', () => {
    expect(pendingChangeStatus(row(), effectiveAt)).toBe('ready');
  });

  it('is ready 1ms before expiresAt', () => {
    expect(pendingChangeStatus(row(), at(-1, expiresAt))).toBe('ready');
  });

  it('is expired at expiresAt to the exact millisecond', () => {
    expect(pendingChangeStatus(row(), expiresAt)).toBe('expired');
  });

  it('expired wins over ready when both bounds have passed', () => {
    expect(pendingChangeStatus(row(), at(86_400_000, expiresAt))).toBe('expired');
  });

  it('expired wins over waiting when expiry precedes effectiveAt', () => {
    const early = row({ pendingExpiresAt: at(-1000, effectiveAt) });
    expect(pendingChangeStatus(early, at(-500, effectiveAt))).toBe('expired');
  });

  it('is never expired without an expiry', () => {
    const open = row({ pendingExpiresAt: null });
    expect(pendingChangeStatus(open, new Date('2099-01-01T00:00:00.000Z'))).toBe('ready');
  });
});
