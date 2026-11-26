import type { WagerContext } from '@openora/core/contracts';
import { describe, expect, it } from 'vitest';
import {
  effectiveContribution,
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

describe('effectiveContribution', () => {
  const row = (scope: WagerWeightRow['scope'], scopeRef: string | null, percent: string) =>
    ({ scope, scopeRef, contributionPercent: percent }) satisfies WagerWeightRow;
  const casino = (extra: Partial<WagerContext> = {}): WagerContext => ({
    provider: 'p',
    product: 'casino',
    ...extra,
  });
  const edgeRows = [row('category', 'table', '70'), row('default', null, '100')];
  const table = (rtp?: string) => casino({ categorySlug: 'table', ...(rtp ? { rtp } : {}) });
  const houseEdge = (rtp?: string) =>
    effectiveContribution({
      rows: edgeRows,
      context: table(rtp),
      mode: 'house_edge',
      referenceEdge: '0.04',
    });
  const fullEdge = (rtp: string, referenceEdge: string) =>
    effectiveContribution({
      rows: [row('default', null, '100')],
      context: casino({ rtp }),
      mode: 'house_edge',
      referenceEdge,
    });
  const n = (v: string) => Number(v);

  it('takes the profile percent as is in flat mode, rtp or not', () => {
    const c = effectiveContribution({ rows: edgeRows, context: table('0.5'), mode: 'flat' });
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
    expect(n(fullEdge('0.5', '0.000000000000000001').effectivePercent)).toBe(100);
    expect(
      weightedStake(
        '1000000000000000000000000',
        fullEdge('0.5', '0.000000000000000001').effectivePercent,
      ),
    ).toBe('1000000000000000000000000.000000000000000000');
  });

  it('counts a game whose edge equals the reference edge in full, and one unit less below it', () => {
    expect(n(fullEdge('0.96', '0.04').effectivePercent)).toBe(100);
    expect(fullEdge('0.960000000000000001', '0.04').effectivePercent).toBe('99.999999999999997500');
  });

  it('prices a reference edge of one as the game edge itself', () => {
    expect(n(fullEdge('0.5', '1').effectivePercent)).toBe(50);
    expect(fullEdge('0.000000000000000001', '1').effectivePercent).toBe('99.999999999999999900');
  });

  it.each(['0', '0.000000000000000000', undefined, null, ''])(
    'counts nothing for a terms reference edge of %s',
    (referenceEdge) => {
      const c = effectiveContribution({
        rows: edgeRows,
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
    expect(weightedStake('1', fullEdge('0.99', '0.03').effectivePercent)).toBe(
      '0.333333333333333333',
    );
  });

  it('never lets a contributed stake exceed the stake at full percent', () => {
    const units = (v: string) => BigInt(v.padEnd(v.indexOf('.') + 19, '0').replace('.', ''));
    for (const rtp of ['0.1', '0.5', '0.9', '0.95', '0.999999999999999999']) {
      for (const edge of ['0.000000000000000001', '0.01', '0.5', '1']) {
        for (const stake of ['0.000000000000000001', '0.01', '123.456789', '99999999999999.99']) {
          const got = weightedStake(stake, fullEdge(rtp, edge).effectivePercent);
          expect(units(got) <= units(stake)).toBe(true);
        }
      }
    }
  });
});
