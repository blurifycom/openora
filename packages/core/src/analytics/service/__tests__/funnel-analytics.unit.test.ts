import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { dropOffRate } from '../funnel-analytics.service.js';

describe('dropOffRate', () => {
  it.each([
    [0, 0, 0],
    [0, 5, 0],
    [100, 100, 0],
    [100, 0, 1],
    [100, 25, 0.75],
    [4, 1, 0.75],
  ])('from %i to %i drops %f', (previous, current, expected) => {
    expect(dropOffRate(previous, current)).toBe(expected);
  });

  it('never divides by zero', () => {
    fc.assert(
      fc.property(fc.nat(), (current) => {
        expect(Number.isFinite(dropOffRate(0, current))).toBe(true);
      }),
    );
  });

  it('stays between 0 and 1 for a narrowing funnel', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1_000_000 }), fc.nat(), (previous, seed) => {
        const current = seed % (previous + 1);
        const rate = dropOffRate(previous, current);
        expect(rate).toBeGreaterThanOrEqual(0);
        expect(rate).toBeLessThanOrEqual(1);
      }),
    );
  });
});
