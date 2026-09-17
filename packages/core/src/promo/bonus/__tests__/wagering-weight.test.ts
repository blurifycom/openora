import { describe, expect, it } from 'vitest';
import type { WagerContext } from '@openora/core/contracts';
import {
  resolveContributionPercent,
  weightedStake,
  type WagerWeightRow,
} from '../shared/wagering-weight.js';

const casino = (over: Partial<WagerContext> = {}): WagerContext => ({
  provider: 'aggregator',
  product: 'casino',
  ...over,
});

const row = (
  scope: WagerWeightRow['scope'],
  scopeRef: string | null,
  contributionPercent: string,
): WagerWeightRow => ({ scope, scopeRef, contributionPercent });

describe('resolveContributionPercent', () => {
  it('a casino bet with a 100 percent product weight counts in full', () => {
    expect(resolveContributionPercent([row('product', 'casino', '100')], casino())).toBe('100');
  });

  it('a game-level weight is what applies when the game is known', () => {
    const rows = [row('product', 'casino', '100'), row('game', 'game-a', '50')];
    expect(resolveContributionPercent(rows, casino({ gameId: 'game-a' }))).toBe('50');
  });

  it('a PvP bet does not count', () => {
    const rows = [row('product', 'casino', '100'), row('product', 'pvp', '0')];
    expect(resolveContributionPercent(rows, casino({ product: 'pvp' }))).toBe('0');
  });

  it('a sportsbook bet does not count', () => {
    const rows = [row('product', 'casino', '100'), row('product', 'sportsbook', '0')];
    expect(resolveContributionPercent(rows, casino({ product: 'sportsbook' }))).toBe('0');
  });

  it('an unresolved game on a casino product falls through to the product weight', () => {
    const rows = [row('product', 'casino', '100'), row('game', 'game-a', '50')];
    expect(resolveContributionPercent(rows, casino())).toBe('100');
  });

  it('an unresolved game on a PvP product still does not count', () => {
    const rows = [row('product', 'casino', '100'), row('product', 'pvp', '0')];
    expect(resolveContributionPercent(rows, casino({ product: 'pvp' }))).toBe('0');
  });

  it('resolution order is game, then category, then product, then the default', () => {
    const rows = [
      row('default', null, '10'),
      row('product', 'casino', '20'),
      row('category', 'slots', '30'),
      row('game', 'game-a', '40'),
    ];
    const full = casino({ gameId: 'game-a', categorySlug: 'slots' });

    expect(resolveContributionPercent(rows, full)).toBe('40');
    expect(resolveContributionPercent(rows.slice(0, 3), full)).toBe('30');
    expect(resolveContributionPercent(rows.slice(0, 2), full)).toBe('20');
    expect(resolveContributionPercent(rows.slice(0, 1), full)).toBe('10');
  });

  it('counts nothing when the profile has no row that matches and no default', () => {
    expect(
      resolveContributionPercent([row('product', 'casino', '100')], casino({ product: 'pvp' })),
    ).toBe('0');
  });

  it('counts nothing for an empty profile', () => {
    expect(resolveContributionPercent([], casino())).toBe('0');
  });

  it('counts nothing when the bet names no product at all', () => {
    expect(resolveContributionPercent([row('product', 'casino', '100')], { provider: 'x' })).toBe(
      '0',
    );
  });

  it('does not match a scoped row against a different reference', () => {
    const rows = [row('game', 'game-a', '50'), row('default', null, '100')];
    expect(resolveContributionPercent(rows, casino({ gameId: 'game-b' }))).toBe('100');
  });

  it('ignores a scoped row whose reference is null', () => {
    const rows = [row('game', null, '50'), row('default', null, '100')];
    expect(resolveContributionPercent(rows, casino({ gameId: 'game-a' }))).toBe('100');
  });

  it('is case sensitive on a product, so a vendor casing change cannot silently re-weight', () => {
    const rows = [row('product', 'casino', '100')];
    expect(resolveContributionPercent(rows, casino({ product: 'Casino' }))).toBe('0');
  });
});

describe('weightedStake', () => {
  it('a full-weight stake passes through unchanged', () => {
    expect(weightedStake('100', '100')).toBe('100.000000000000000000');
  });

  it('a half-weight stake halves', () => {
    expect(weightedStake('100', '50')).toBe('50.000000000000000000');
  });

  it('a zero weight contributes nothing', () => {
    expect(weightedStake('100', '0')).toBe('0.000000000000000000');
  });

  it('handles a fractional weight exactly, with no float drift', () => {
    expect(weightedStake('0.1', '33.33')).toBe('0.033330000000000000');
  });

  it('truncates rather than rounds up, so weighting can never over-credit', () => {
    expect(weightedStake('0.000000000000000001', '50')).toBe('0.000000000000000000');
  });

  it('a zero stake contributes nothing at any weight', () => {
    expect(weightedStake('0', '100')).toBe('0.000000000000000000');
  });
});
