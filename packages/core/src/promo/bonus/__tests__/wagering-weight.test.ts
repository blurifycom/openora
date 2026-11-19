import { describe, expect, it } from 'vitest';
import type { WagerContext } from '@openora/core/contracts';
import {
  effectiveContribution,
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

  it('does not match a scoped row against a different reference', () => {
    const rows = [row('game', 'game-a', '50'), row('default', null, '100')];
    expect(resolveContributionPercent(rows, casino({ gameId: 'game-b' }))).toBe('100');
  });

  it('ignores a scoped row whose reference is null', () => {
    const rows = [row('game', null, '50'), row('default', null, '100')];
    expect(resolveContributionPercent(rows, casino({ gameId: 'game-a' }))).toBe('100');
  });

  it('counts nothing for a product outside the canonical set, even under a positive default', () => {
    const rows = [row('product', 'casino', '100'), row('default', null, '100')];
    for (const product of ['sports', 'Casino', '']) {
      const uncheckedAdapterContext = { provider: 'aggregator', product } as WagerContext;
      expect(resolveContributionPercent(rows, uncheckedAdapterContext)).toBe('0');
    }
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

describe('effectiveContribution', () => {
  const rows = [row('category', 'table', '70'), row('default', null, '100')];
  const table = (rtp?: string) => casino({ categorySlug: 'table', ...(rtp ? { rtp } : {}) });
  const houseEdge = (rtp?: string) =>
    effectiveContribution({ rows, context: table(rtp), mode: 'house_edge', referenceEdge: '0.04' });
  const full = (rtp: string, referenceEdge: string) =>
    effectiveContribution({
      rows: [row('default', null, '100')],
      context: casino({ rtp }),
      mode: 'house_edge',
      referenceEdge,
    });
  const n = (v: string) => Number(v);

  it('takes the profile percent as is in flat mode, rtp or not', () => {
    const c = effectiveContribution({ rows, context: table('0.5'), mode: 'flat' });
    expect(c).toEqual({ categoryPercent: '70', effectivePercent: '70', referenceEdge: null });
    expect(n(weightedStake('100', c.effectivePercent))).toBe(70);
  });

  it('scales the category percent by the edge against the reference edge', () => {
    const c = houseEdge('0.97');
    expect(n(c.effectivePercent)).toBe(52.5);
    expect(c.referenceEdge).toBe('0.04');
    expect(weightedStake('100', c.effectivePercent)).toBe('52.500000000000000000');
  });

  it('caps the scale at one when the game edge is above the reference', () => {
    expect(n(houseEdge('0.90').effectivePercent)).toBe(70);
    expect(n(full('0.5', '0.000000000000000001').effectivePercent)).toBe(100);
    expect(
      weightedStake(
        '1000000000000000000000000',
        full('0.5', '0.000000000000000001').effectivePercent,
      ),
    ).toBe('1000000000000000000000000.000000000000000000');
  });

  it('counts a game whose edge equals the reference edge in full, and one unit less below it', () => {
    expect(n(full('0.96', '0.04').effectivePercent)).toBe(100);
    expect(full('0.960000000000000001', '0.04').effectivePercent).toBe('99.999999999999997500');
  });

  it('prices a reference edge of one as the game edge itself', () => {
    expect(n(full('0.5', '1').effectivePercent)).toBe(50);
    expect(full('0.000000000000000001', '1').effectivePercent).toBe('99.999999999999999900');
  });

  it.each(['0', '0.000000000000000000', undefined, null, ''])(
    'counts nothing for a terms reference edge of %s',
    (referenceEdge) => {
      const c = effectiveContribution({
        rows,
        context: table('0.96'),
        mode: 'house_edge',
        referenceEdge,
      });
      expect(c.effectivePercent).toBe('0');
    },
  );

  it('gives a game with rtp 1 nothing', () => {
    expect(n(houseEdge('1').effectivePercent)).toBe(0);
  });

  it.each([undefined, '0', '96', '1.2', 'abc'])('counts nothing for unusable rtp %s', (rtp) => {
    const c = houseEdge(rtp);
    expect(c.effectivePercent).toBe('0');
    expect(n(weightedStake('100', c.effectivePercent))).toBe(0);
  });

  it('truncates rather than rounding up', () => {
    // (1 - 0.99) / 0.03 = 0.333...; never rounded to ...334.
    expect(weightedStake('1', full('0.99', '0.03').effectivePercent)).toBe('0.333333333333333333');
  });

  it('never lets a contributed stake exceed the stake at full percent', () => {
    const units = (v: string) => BigInt(v.padEnd(v.indexOf('.') + 19, '0').replace('.', ''));
    for (const rtp of ['0.1', '0.5', '0.9', '0.95', '0.999999999999999999']) {
      for (const edge of ['0.000000000000000001', '0.01', '0.5', '1']) {
        for (const stake of ['0.000000000000000001', '0.01', '123.456789', '99999999999999.99']) {
          const got = weightedStake(stake, full(rtp, edge).effectivePercent);
          expect(units(got) <= units(stake)).toBe(true);
        }
      }
    }
  });
});
