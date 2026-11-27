import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { WagerContext } from '@openora/core/contracts';
import { moneyCompare, moneyEquals } from '@openora/core/server';
import {
  resolveContributionPercent,
  weightedStake,
  type WagerWeightRow,
} from '../wagering-weight.js';

const ctx = (over: Partial<WagerContext>): WagerContext => ({
  provider: 'agg',
  product: 'casino',
  ...over,
});

const rows: WagerWeightRow[] = [
  { scope: 'default', scopeRef: null, contributionPercent: '10' },
  { scope: 'product', scopeRef: 'casino', contributionPercent: '20' },
  { scope: 'category', scopeRef: 'slots', contributionPercent: '30' },
  { scope: 'game', scopeRef: 'g1', contributionPercent: '40' },
];

describe('resolveContributionPercent', () => {
  it.each([
    [
      'game beats category, product and default',
      ctx({ gameId: 'g1', categorySlug: 'slots' }),
      '40',
    ],
    ['category beats product and default', ctx({ gameId: 'g2', categorySlug: 'slots' }), '30'],
    ['product beats default', ctx({ gameId: 'g2', categorySlug: 'table' }), '20'],
    ['product applies without game or category', ctx({}), '20'],
    ['default applies to a product with no row', ctx({ product: 'live-casino' }), '10'],
  ])('%s', (_name, context, expected) => {
    expect(resolveContributionPercent(rows, context)).toBe(expected);
  });

  it('returns 0 when the profile has no default and nothing matches', () => {
    expect(resolveContributionPercent([], ctx({}))).toBe('0');
    expect(
      resolveContributionPercent(
        [{ scope: 'category', scopeRef: 'slots', contributionPercent: '50' }],
        ctx({ categorySlug: 'table' }),
      ),
    ).toBe('0');
  });

  it('returns 0 for an unknown product even under a positive default', () => {
    const unknown: WagerContext = Object.assign(ctx({}), { product: 'lottery' });
    expect(resolveContributionPercent(rows, unknown)).toBe('0');
  });

  it('does not match a game row against a category with the same ref', () => {
    const only: WagerWeightRow[] = [
      { scope: 'game', scopeRef: 'slots', contributionPercent: '50' },
    ];
    expect(resolveContributionPercent(only, ctx({ categorySlug: 'slots' }))).toBe('0');
  });

  it('keeps an explicit 0 percent row instead of falling through', () => {
    const zero: WagerWeightRow[] = [
      { scope: 'default', scopeRef: null, contributionPercent: '100' },
      { scope: 'game', scopeRef: 'g1', contributionPercent: '0' },
    ];
    expect(resolveContributionPercent(zero, ctx({ gameId: 'g1' }))).toBe('0');
  });
});

describe('weightedStake', () => {
  it.each([
    ['100', '50', '50'],
    ['100', '100', '100'],
    ['100', '0', '0'],
    ['10', '2.5', '0.25'],
    ['100', '200', '200'],
    ['0.000000000000000001', '50', '0'],
    ['0.000000000000000003', '50', '0.000000000000000001'],
    ['1000.000000000000000001', '100', '1000.000000000000000001'],
  ])('weights stake %s at %s percent to %s', (stake, percent, expected) => {
    expect(moneyEquals(weightedStake(stake, percent), expected)).toBe(true);
  });

  const money = fc
    .bigInt({ min: 0n, max: 10n ** 27n })
    .map((u) => `${u / 10n ** 18n}.${(u % 10n ** 18n).toString().padStart(18, '0')}`);
  const percent = fc.integer({ min: 0, max: 100 }).map(String);

  it('never exceeds the stake at or below 100 percent', () => {
    fc.assert(
      fc.property(money, percent, (stake, p) => {
        expect(moneyCompare(weightedStake(stake, p), stake)).toBeLessThanOrEqual(0);
      }),
    );
  });

  it('is monotonic in the percent', () => {
    fc.assert(
      fc.property(money, percent, percent, (stake, a, b) => {
        const [lo, hi] = Number(a) <= Number(b) ? [a, b] : [b, a];
        expect(
          moneyCompare(weightedStake(stake, lo), weightedStake(stake, hi)),
        ).toBeLessThanOrEqual(0);
      }),
    );
  });
});
