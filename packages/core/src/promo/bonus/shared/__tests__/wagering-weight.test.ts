import type { WagerContext } from '@openora/core/contracts';
import { describe, expect, it } from 'vitest';
import {
  resolveContributionPercent,
  type WagerWeightRow,
  weightedStake,
} from '../wagering-weight.js';

const rows: WagerWeightRow[] = [
  { scope: 'game', scopeRef: 'game-1', contributionPercent: '5' },
  { scope: 'category', scopeRef: 'slots', contributionPercent: '50' },
  { scope: 'product', scopeRef: 'casino', contributionPercent: '75' },
  { scope: 'default', scopeRef: null, contributionPercent: '10' },
];

const full: WagerContext = {
  provider: 'p',
  product: 'casino',
  gameId: 'game-1',
  categorySlug: 'slots',
};

describe('resolveContributionPercent', () => {
  it('returns 0 for an unknown product even when a positive default exists', () => {
    const context: WagerContext = { provider: 'p', product: 'casino', gameId: 'game-1' };
    Object.defineProperty(context, 'product', { value: 'poker' });
    expect(resolveContributionPercent(rows, context)).toBe('0');
  });

  it('returns the game row percent when a game-scoped row matches', () => {
    expect(resolveContributionPercent(rows, full)).toBe('5');
  });

  it('falls back to the category row when no game row matches', () => {
    expect(resolveContributionPercent(rows, { ...full, gameId: 'game-2' })).toBe('50');
  });

  it('falls back to the product default when no narrower row matches', () => {
    expect(
      resolveContributionPercent(rows, { ...full, gameId: 'game-2', categorySlug: 'table' }),
    ).toBe('75');
    expect(
      resolveContributionPercent(rows, {
        provider: 'p',
        product: 'sportsbook',
        gameId: 'game-1',
        categorySlug: 'slots',
      }),
    ).toBe('5');
    expect(resolveContributionPercent(rows, { provider: 'p', product: 'sportsbook' })).toBe('10');
  });

  it('returns 0 when no row matches and there is no default row', () => {
    const withoutDefault = rows.filter((r) => r.scope !== 'default');
    expect(resolveContributionPercent(withoutDefault, { provider: 'p', product: 'pvp' })).toBe('0');
    expect(resolveContributionPercent([], full)).toBe('0');
  });

  it('skips a level whose reference is missing in the context', () => {
    expect(resolveContributionPercent(rows, { provider: 'p', product: 'casino' })).toBe('75');
    expect(
      resolveContributionPercent(rows, { provider: 'p', product: 'casino', categorySlug: 'slots' }),
    ).toBe('50');
    const gameRowOnly: WagerWeightRow[] = [
      { scope: 'game', scopeRef: 'game-1', contributionPercent: '5' },
    ];
    expect(resolveContributionPercent(gameRowOnly, { provider: 'p', product: 'casino' })).toBe('0');
  });
});

describe('weightedStake', () => {
  it('weights a stake at 100 percent as the full stake', () => {
    expect(weightedStake('12.5', '100')).toBe('12.500000000000000000');
  });

  it('weights a stake at 10 percent as a tenth', () => {
    expect(weightedStake('12.5', '10')).toBe('1.250000000000000000');
  });

  it('weights a stake at 0 percent as zero', () => {
    expect(weightedStake('12.5', '0')).toBe('0.000000000000000000');
  });

  it('truncates a fractional result and never rounds up', () => {
    expect(weightedStake('0.000000000000000019', '50')).toBe('0.000000000000000009');
    expect(weightedStake('0.000000000000000001', '99')).toBe('0.000000000000000000');
  });
});
