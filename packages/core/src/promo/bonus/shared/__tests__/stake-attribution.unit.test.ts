import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { moneyAdd, moneyCompare, moneyEquals } from '@openora/core/server';
import { attributeStake, type AttributionGrant } from '../stake-attribution.js';
import { weightedStake } from '../wagering-weight.js';

const grant = (
  over: Partial<AttributionGrant<string>> & { id: string },
): AttributionGrant<string> => ({
  headroom: '100',
  percent: '100',
  bonusStake: '0',
  ...over,
});

const total = (values: string[]) => values.reduce((s, v) => moneyAdd(s, v), '0');

describe('attributeStake', () => {
  it('returns nothing for no grants', () => {
    expect(attributeStake([], '10')).toEqual([]);
  });

  it('fills the first grant when it has room', () => {
    const [a, b] = attributeStake([grant({ id: 'a' }), grant({ id: 'b' })], '40');
    expect(moneyEquals(a?.realStake ?? '', '40')).toBe(true);
    expect(moneyEquals(a?.progress ?? '', '40')).toBe(true);
    expect(moneyEquals(b?.realStake ?? '', '0')).toBe(true);
    expect(moneyEquals(b?.progress ?? '', '0')).toBe(true);
  });

  it('carries the overflow of a full grant to the next', () => {
    const [a, b] = attributeStake([grant({ id: 'a', headroom: '30' }), grant({ id: 'b' })], '50');
    expect(moneyEquals(a?.realStake ?? '', '30')).toBe(true);
    expect(moneyEquals(a?.progress ?? '', '30')).toBe(true);
    expect(moneyEquals(b?.realStake ?? '', '20')).toBe(true);
    expect(moneyEquals(b?.progress ?? '', '20')).toBe(true);
  });

  it('weights the carried stake by the next grant own percent', () => {
    const [a, b] = attributeStake(
      [grant({ id: 'a', headroom: '10', percent: '50' }), grant({ id: 'b', percent: '100' })],
      '30',
    );
    expect(moneyEquals(a?.realStake ?? '', '20')).toBe(true);
    expect(moneyEquals(a?.progress ?? '', '10')).toBe(true);
    expect(moneyEquals(b?.realStake ?? '', '10')).toBe(true);
    expect(moneyEquals(b?.progress ?? '', '10')).toBe(true);
  });

  it('progresses a grant alone from its own bonus stake', () => {
    const [a, b] = attributeStake(
      [grant({ id: 'a', bonusStake: '20', percent: '50' }), grant({ id: 'b', bonusStake: '5' })],
      '0',
    );
    expect(moneyEquals(a?.progress ?? '', '10')).toBe(true);
    expect(moneyEquals(b?.progress ?? '', '5')).toBe(true);
  });

  it('caps bonus-funded progress at headroom', () => {
    const [a] = attributeStake([grant({ id: 'a', headroom: '5', bonusStake: '20' })], '0');
    expect(moneyEquals(a?.progress ?? '', '5')).toBe(true);
  });

  it('leaves the whole real stake on the first grant when no requirement absorbs it', () => {
    const [a, b] = attributeStake(
      [grant({ id: 'a', headroom: '0' }), grant({ id: 'b', percent: '0' })],
      '25',
    );
    expect(moneyEquals(a?.realStake ?? '', '25')).toBe(true);
    expect(moneyEquals(a?.progress ?? '', '0')).toBe(true);
    expect(moneyEquals(b?.realStake ?? '', '0')).toBe(true);
  });

  it('skips a zero-percent grant and lets the next one absorb', () => {
    const [a, b] = attributeStake([grant({ id: 'a', percent: '0' }), grant({ id: 'b' })], '15');
    expect(moneyEquals(a?.progress ?? '', '0')).toBe(true);
    expect(moneyEquals(b?.realStake ?? '', '15')).toBe(true);
    expect(moneyEquals(b?.progress ?? '', '15')).toBe(true);
  });

  it('does not let a zero-percent first grant absorb the stake when the next has a positive percent', () => {
    const [a, b, c] = attributeStake(
      [
        grant({ id: 'a', percent: '0', headroom: '100' }),
        grant({ id: 'b', percent: '0', headroom: '100' }),
        grant({ id: 'c', percent: '50', headroom: '100' }),
      ],
      '40',
    );
    expect(moneyEquals(a?.realStake ?? '', '0')).toBe(true);
    expect(moneyEquals(b?.realStake ?? '', '0')).toBe(true);
    expect(moneyEquals(c?.realStake ?? '', '40')).toBe(true);
    expect(moneyEquals(c?.progress ?? '', '20')).toBe(true);
  });

  it('passes a stake that weights to nothing past a grant with no room left', () => {
    const [a, b] = attributeStake(
      [
        grant({ id: 'a', percent: '50', headroom: '5', bonusStake: '10' }),
        grant({ id: 'b', percent: '50', headroom: '100' }),
      ],
      '0.000000000000000001',
    );
    expect(moneyEquals(a?.realStake ?? '', '0')).toBe(true);
    expect(moneyEquals(a?.progress ?? '', '5')).toBe(true);
    expect(moneyEquals(b?.realStake ?? '', '0.000000000000000001')).toBe(true);
  });

  it('passes the stake on from a grant with no room left', () => {
    const [a, b] = attributeStake(
      [grant({ id: 'a', headroom: '10', bonusStake: '10' }), grant({ id: 'b' })],
      '7',
    );
    expect(moneyEquals(a?.realStake ?? '', '0')).toBe(true);
    expect(moneyEquals(b?.realStake ?? '', '7')).toBe(true);
    expect(moneyEquals(b?.progress ?? '', '7')).toBe(true);
  });

  it('echoes ids and bonus stakes in order', () => {
    const out = attributeStake([grant({ id: 'x', bonusStake: '3' }), grant({ id: 'y' })], '1');
    expect(out.map((o) => [o.id, o.bonusStake])).toEqual([
      ['x', '3'],
      ['y', '0'],
    ]);
  });

  const money = (max: bigint) =>
    fc
      .bigInt({ min: 0n, max })
      .map((u) => `${u / 10n ** 18n}.${(u % 10n ** 18n).toString().padStart(18, '0')}`);
  const arbGrant = fc.record({
    headroom: money(10n ** 21n),
    percent: fc.integer({ min: 0, max: 200 }).map(String),
    bonusStake: money(10n ** 20n),
  });
  const arbGrants = fc
    .array(arbGrant, { minLength: 1, maxLength: 5 })
    .map((gs) => gs.map((g, i) => ({ ...g, id: String(i) })));
  const arbReal = money(10n ** 22n);

  it('attributed real parts sum to the real stake', () => {
    fc.assert(
      fc.property(arbGrants, arbReal, (grants, real) => {
        const out = attributeStake(grants, real);
        expect(moneyEquals(total(out.map((o) => o.realStake)), real)).toBe(true);
      }),
    );
  });

  it('never gives a grant more progress than its headroom', () => {
    fc.assert(
      fc.property(arbGrants, arbReal, (grants, real) => {
        const out = attributeStake(grants, real);
        out.forEach((o, i) => {
          expect(moneyCompare(o.progress, grants[i]?.headroom ?? '0')).toBeLessThanOrEqual(0);
        });
      }),
    );
  });

  it('never counts a stake twice: progress does not exceed the weighted stake it took', () => {
    fc.assert(
      fc.property(arbGrants, arbReal, (grants, real) => {
        const out = attributeStake(grants, real);
        out.forEach((o, i) => {
          const g = grants[i];
          if (!g) {
            return;
          }
          const stake = moneyAdd(o.bonusStake, o.realStake);
          expect(moneyCompare(o.progress, weightedStake(stake, g.percent))).toBeLessThanOrEqual(0);
        });
      }),
    );
  });

  it('is deterministic', () => {
    fc.assert(
      fc.property(arbGrants, arbReal, (grants, real) => {
        expect(attributeStake(grants, real)).toEqual(attributeStake(grants, real));
      }),
    );
  });
});
