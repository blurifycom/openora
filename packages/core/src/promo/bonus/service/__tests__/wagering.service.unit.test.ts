import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { moneyAdd, moneyCompare, moneyEquals, moneyScaleBy } from '@openora/core/server';
import { allocateBonusStake, capConversion, strictestMaxBet } from '../wagering.service.js';

type Grant = Parameters<typeof strictestMaxBet>[0][number];

const grant = (
  over: Partial<Omit<Grant, 'terms'>> & { terms?: Partial<Grant['terms']> },
): Grant => ({
  id: '00000000-0000-4000-8000-000000000001',
  grantedAmount: '100',
  bonusBalance: '100',
  wageringRequired: '1000',
  wageringProgress: '0',
  ...over,
  terms: { wageringMultiplier: '10', expiryDays: 7, weights: [], ...over.terms },
});

const same = (a: string | null, b: string | null) =>
  a === null || b === null ? a === b : moneyEquals(a, b);

describe('capConversion', () => {
  it.each([
    ['no multiplier', '500', '100', undefined, '500'],
    ['null multiplier', '500', '100', null, '500'],
    ['balance above the ceiling', '500', '100', '3', '300'],
    ['balance below the ceiling', '200', '100', '3', '200'],
    ['balance at the ceiling', '300', '100', '3', '300'],
    ['zero multiplier pays nothing', '500', '100', '0', '0'],
    ['fractional multiplier', '500', '100', '1.5', '150'],
    ['ceiling truncates', '500', '0.000000000000000003', '0.5', '0.000000000000000001'],
  ])('%s', (_name, balance, granted, multiplier, expected) => {
    expect(moneyEquals(capConversion(balance, granted, multiplier), expected)).toBe(true);
  });

  const money = fc
    .bigInt({ min: 0n, max: 10n ** 27n })
    .map((u) => `${u / 10n ** 18n}.${(u % 10n ** 18n).toString().padStart(18, '0')}`);

  it('never converts more than the balance or the ceiling', () => {
    fc.assert(
      fc.property(money, money, fc.integer({ min: 0, max: 50 }), (balance, granted, mult) => {
        const out = capConversion(balance, granted, String(mult));
        expect(moneyCompare(out, balance)).toBeLessThanOrEqual(0);
        expect(moneyCompare(out, moneyScaleBy(granted, String(mult)))).toBeLessThanOrEqual(0);
        expect(
          moneyEquals(
            out,
            moneyCompare(balance, moneyScaleBy(granted, String(mult))) < 0
              ? balance
              : moneyScaleBy(granted, String(mult)),
          ),
        ).toBe(true);
      }),
    );
  });
});

describe('strictestMaxBet', () => {
  it('is null with no grants', () => {
    expect(strictestMaxBet([], 'casino')).toBeNull();
  });

  it('is null when no grant sets a max bet', () => {
    expect(strictestMaxBet([grant({}), grant({ terms: { maxBet: null } })], 'casino')).toBeNull();
  });

  it('takes the lowest max bet', () => {
    const grants = [
      grant({ terms: { maxBet: '10' } }),
      grant({ terms: { maxBet: '2.5' } }),
      grant({ terms: { maxBet: '5' } }),
    ];
    expect(same(strictestMaxBet(grants, 'casino'), '2.5')).toBe(true);
  });

  it('ignores a grant that exempts the product', () => {
    const grants = [
      grant({ terms: { maxBet: '1', maxBetExemptProducts: ['live-casino'] } }),
      grant({ terms: { maxBet: '5' } }),
    ];
    expect(same(strictestMaxBet(grants, 'live-casino'), '5')).toBe(true);
    expect(same(strictestMaxBet(grants, 'casino'), '1')).toBe(true);
  });

  it('is null when every limiting grant exempts the product', () => {
    const grants = [grant({ terms: { maxBet: '1', maxBetExemptProducts: ['pvp'] } })];
    expect(strictestMaxBet(grants, 'pvp')).toBeNull();
  });

  it('treats a zero max bet as the strictest limit', () => {
    const grants = [grant({ terms: { maxBet: '5' } }), grant({ terms: { maxBet: '0' } })];
    expect(same(strictestMaxBet(grants, 'casino'), '0')).toBe(true);
  });
});

describe('allocateBonusStake', () => {
  const grants = [
    grant({ bonusBalance: '30' }),
    grant({ bonusBalance: '50' }),
    grant({ bonusBalance: '20' }),
  ];

  it.each([
    ['zero draws nothing', '0', ['0', '0', '0']],
    ['within the first grant', '10', ['10', '0', '0']],
    ['exactly the first grant', '30', ['30', '0', '0']],
    ['spills into the second', '45', ['30', '15', '0']],
    ['spills into the third', '95', ['30', '50', '15']],
    ['exactly everything', '100', ['30', '50', '20']],
  ])('%s', (_name, fromBonus, expected) => {
    const out = allocateBonusStake(grants, fromBonus, 'casino');
    expect(out).not.toBeNull();
    expect(out?.every((v, i) => moneyEquals(v, expected[i] ?? ''))).toBe(true);
    expect(out).toHaveLength(3);
  });

  it('returns null when the grants cannot cover it', () => {
    expect(allocateBonusStake(grants, '100.000000000000000001', 'casino')).toBeNull();
  });

  it('skips a grant that excludes the product and does not count its balance', () => {
    const mixed = [
      grant({ bonusBalance: '30', terms: { excludedProducts: ['casino'] } }),
      grant({ bonusBalance: '50' }),
    ];
    const out = allocateBonusStake(mixed, '40', 'casino');
    expect(out?.every((v, i) => moneyEquals(v, ['0', '40'][i] ?? ''))).toBe(true);
    expect(allocateBonusStake(mixed, '60', 'casino')).toBeNull();
    expect(allocateBonusStake(mixed, '60', 'live-casino')?.length).toBe(2);
  });

  it('returns null for any positive draw when every grant excludes the product', () => {
    const all = [grant({ terms: { excludedProducts: ['pvp'] } })];
    expect(allocateBonusStake(all, '1', 'pvp')).toBeNull();
    expect(allocateBonusStake(all, '0', 'pvp')).toEqual(['0']);
  });

  it('returns null for an empty grant list and a positive draw', () => {
    expect(allocateBonusStake([], '1', 'casino')).toBeNull();
    expect(allocateBonusStake([], '0', 'casino')).toEqual([]);
  });

  const money = (max: bigint) =>
    fc
      .bigInt({ min: 0n, max })
      .map((u) => `${u / 10n ** 18n}.${(u % 10n ** 18n).toString().padStart(18, '0')}`);

  it('draws exactly the stake and never more than a grant holds', () => {
    fc.assert(
      fc.property(
        fc.array(money(10n ** 21n), { minLength: 1, maxLength: 5 }),
        money(10n ** 22n),
        (balances, stake) => {
          const gs = balances.map((bonusBalance) => grant({ bonusBalance }));
          const out = allocateBonusStake(gs, stake, 'casino');
          const held = balances.reduce((s, b) => moneyAdd(s, b), '0');
          if (out === null) {
            expect(moneyCompare(stake, held)).toBeGreaterThan(0);
            return;
          }
          expect(
            moneyEquals(
              out.reduce((s, v) => moneyAdd(s, v), '0'),
              stake,
            ),
          ).toBe(true);
          out.forEach((v, i) => {
            expect(moneyCompare(v, balances[i] ?? '0')).toBeLessThanOrEqual(0);
          });
        },
      ),
    );
  });
});
