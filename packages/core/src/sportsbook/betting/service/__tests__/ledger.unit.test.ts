import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { moneyCompare, moneyEquals } from '@openora/core/server';
import type { SportsbookBetLeg, SportsbookBetResult } from '@openora/core/contracts';
import {
  cashPromotionCeiling,
  invalidTerms,
  isUnusualPromotionPayout,
  isValidPromotionAmount,
  isValidSettlement,
  oddsDirection,
  resolveStake,
} from '../ledger.service.js';

const RESULTS = ['won', 'lost', 'void', 'half_won', 'half_lost', 'cashed_out'] as const;

const money = (cents: number) =>
  `${Math.trunc(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
const cents = fc.integer({ min: 0, max: 100_000 }).map(money);
const oddsCents = fc.integer({ min: 100, max: 5000 }).map(money);

const leg = (over: Partial<SportsbookBetLeg> = {}): SportsbookBetLeg => ({
  eventId: 'e1',
  startsAt: '2026-03-01T12:00:00.000Z',
  odds: '2.00',
  ...over,
});

describe('resolveStake', () => {
  it.each([
    ['no promotion', undefined, { cashStake: '10', voidPayout: '10', maxLossRefund: '0' }],
    [
      'a player-staked promotion without a loss refund',
      { type: 'boost', stake: 'player', refundsLoss: false } as const,
      { cashStake: '10', voidPayout: '10', maxLossRefund: '0' },
    ],
    [
      'a player-staked promotion refunding a loss',
      { type: 'insured', stake: 'player', refundsLoss: true } as const,
      { cashStake: '10', voidPayout: '10', maxLossRefund: '10' },
    ],
    [
      'a promotion-staked bet whose void returns the stake',
      { type: 'free', stake: 'promotion', voidReturnsStake: true } as const,
      { cashStake: '0', voidPayout: '10', maxLossRefund: '0' },
    ],
    [
      'a promotion-staked bet whose void returns nothing',
      { type: 'free', stake: 'promotion', voidReturnsStake: false } as const,
      { cashStake: '0', voidPayout: '0', maxLossRefund: '0' },
    ],
  ])('resolves %s', (_name, promotion, expected) => {
    expect(resolveStake('10', promotion)).toEqual(expected);
  });
});

describe('cashPromotionCeiling', () => {
  const bet = (promotionPotential: string | null, maxLossRefund: string) => ({
    promotionPotential,
    maxLossRefund,
  });

  it.each([
    ['void', 'void', bet('5', '8'), '20', '0'],
    ['void ignores a boost', 'void', bet('9', '0'), '20', '0'],
    ['lost caps at the refund', 'lost', bet('5', '8'), '20', '8'],
    ['lost ignores a boost above the refund', 'lost', bet('9', '8'), '20', '8'],
    ['lost caps at the payout', 'lost', bet('5', '8'), '3', '3'],
    ['half_lost takes the larger of refund and boost', 'half_lost', bet('5', '8'), '20', '8'],
    ['half_lost takes the boost when larger', 'half_lost', bet('9', '8'), '20', '9'],
    ['half_lost caps at the payout', 'half_lost', bet('9', '8'), '4', '4'],
    ['won takes the boost', 'won', bet('5', '8'), '20', '5'],
    ['won caps at the payout', 'won', bet('5', '8'), '2', '2'],
    ['won without a boost is zero', 'won', bet(null, '8'), '20', '0'],
    ['half_won takes the boost', 'half_won', bet('5', '8'), '20', '5'],
    ['cashed_out takes the boost', 'cashed_out', bet('5', '8'), '20', '5'],
  ] as const)('%s', (_name, result, row, payout, expected) => {
    expect(moneyEquals(cashPromotionCeiling(row, result, payout), expected)).toBe(true);
  });

  it('never exceeds the payout nor goes below zero', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...RESULTS),
        fc.option(cents, { nil: null }),
        cents,
        cents,
        (result, potential, refund, payout) => {
          const ceiling = cashPromotionCeiling(
            { promotionPotential: potential, maxLossRefund: refund },
            result,
            payout,
          );
          expect(moneyCompare(ceiling, payout)).toBeLessThanOrEqual(0);
          expect(moneyCompare(ceiling, '0')).toBeGreaterThanOrEqual(0);
        },
      ),
    );
  });
});

describe('isValidSettlement', () => {
  const bet = (over: Partial<Parameters<typeof isValidSettlement>[0]> = {}) => ({
    cashStake: '10',
    voidPayout: '10',
    maxLossRefund: '0',
    currencyDecimals: 2,
    ...over,
  });

  it.each([
    ['won pays any amount', 'won', '123.45', bet(), true],
    ['won with too many decimals', 'won', '1.005', bet(), false],
    ['won with whole currency decimals', 'won', '1.5', bet({ currencyDecimals: 0 }), false],
    ['void at the fixed amount', 'void', '10', bet(), true],
    ['void at another amount', 'void', '9.99', bet(), false],
    ['void of zero on a cash stake', 'void', '0', bet(), false],
    [
      'void of zero on a promotion stake whose void pays nothing',
      'void',
      '0',
      bet({ cashStake: '0', voidPayout: '0' }),
      true,
    ],
    [
      'void of zero on a promotion stake with a refundable stake',
      'void',
      '0',
      bet({ cashStake: '0' }),
      true,
    ],
    [
      'void of its stake on a promotion stake with a refundable stake',
      'void',
      '10',
      bet({ cashStake: '0' }),
      true,
    ],
    ['void of another amount on a promotion stake', 'void', '4', bet({ cashStake: '0' }), false],
    ['lost at zero', 'lost', '0', bet(), true],
    ['lost above a zero refund cap', 'lost', '0.01', bet(), false],
    ['lost at the refund cap', 'lost', '10', bet({ maxLossRefund: '10' }), true],
    ['lost above the refund cap', 'lost', '10.01', bet({ maxLossRefund: '10' }), false],
    ['half_lost is not capped by the refund', 'half_lost', '5', bet(), true],
    ['half_won is not capped by the refund', 'half_won', '25', bet(), true],
    ['cashed_out is not capped by the refund', 'cashed_out', '7', bet(), true],
  ] as const)('%s', (_name, result, payout, row, expected) => {
    expect(isValidSettlement(row, result, payout)).toBe(expected);
  });
});

describe('isValidPromotionAmount', () => {
  const bet = (over: Partial<Parameters<typeof isValidPromotionAmount>[0]> = {}) => ({
    cashStake: '10',
    promotionType: 'boost',
    promotionPotential: '5',
    maxLossRefund: '8',
    currencyDecimals: 2,
    ...over,
  });

  it.each([
    ['won at the boost', 'won', '20', '5', bet(), true],
    ['won above the boost', 'won', '20', '5.01', bet(), false],
    ['won with no promotion part', 'won', '20', '0', bet(), true],
    ['lost at the refund', 'lost', '8', '8', bet(), true],
    ['lost above the refund', 'lost', '8', '8.01', bet(), false],
    ['lost above its payout', 'lost', '3', '3.01', bet(), false],
    ['void takes none of it', 'void', '10', '0.01', bet(), false],
    ['void at zero', 'void', '10', '0', bet(), true],
    ['half_lost at the larger of boost and refund', 'half_lost', '20', '8', bet(), true],
    ['half_lost above it', 'half_lost', '20', '8.01', bet(), false],
    [
      'no promotion bet with a positive part',
      'won',
      '20',
      '1',
      bet({ promotionType: null }),
      false,
    ],
    ['no promotion bet with a zero part', 'won', '20', '0', bet({ promotionType: null }), true],
    ['too many decimals', 'won', '20', '1.005', bet(), false],
    ['promotion stake paying its whole payout', 'won', '20', '20', bet({ cashStake: '0' }), true],
    [
      'promotion stake paying part of its payout',
      'won',
      '20',
      '19',
      bet({ cashStake: '0' }),
      false,
    ],
    ['promotion stake lost refund of zero', 'lost', '0', '0', bet({ cashStake: '0' }), true],
    ['promotion stake void of zero', 'void', '0', '0', bet({ cashStake: '0' }), true],
  ] as const)('%s', (_name, result, payout, promotionAmount, row, expected) => {
    expect(isValidPromotionAmount(row, result, payout, promotionAmount)).toBe(expected);
  });

  it('accepts exactly the whole payout on a promotion-paid bet and nothing else', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<SportsbookBetResult>(...RESULTS),
        cents,
        cents,
        (result, payout, promotionAmount) => {
          const valid = isValidPromotionAmount(
            bet({ cashStake: '0' }),
            result,
            payout,
            promotionAmount,
          );
          expect(valid).toBe(moneyEquals(promotionAmount, payout));
        },
      ),
    );
  });

  it('never accepts a promotion part above the payout of a cash-staked bet', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<SportsbookBetResult>(...RESULTS),
        cents,
        cents,
        cents,
        cents,
        (result, payout, promotionAmount, potential, refund) => {
          const valid = isValidPromotionAmount(
            bet({ promotionPotential: potential, maxLossRefund: refund }),
            result,
            payout,
            promotionAmount,
          );
          if (valid) {
            expect(moneyCompare(promotionAmount, payout)).toBeLessThanOrEqual(0);
          }
        },
      ),
    );
  });
});

describe('isUnusualPromotionPayout', () => {
  const bet = (over: Partial<Parameters<typeof isUnusualPromotionPayout>[0]> = {}) => ({
    cashStake: '0',
    stake: '10',
    legs: [leg({ odds: '2.5' }), leg({ eventId: 'e2', odds: '1.2' })],
    ...over,
  });

  it.each([
    ['at stake times the combined odds', '30', false],
    ['one cent above it', '30.01', true],
    ['below it', '1', false],
  ])('flags a payout %s', (_name, payout, expected) => {
    expect(isUnusualPromotionPayout(bet(), payout)).toBe(expected);
  });

  it.each([
    ['a cash-staked bet', bet({ cashStake: '1' })],
    ['a bet with a non-decimal odds', bet({ legs: [leg({ odds: 'evs' })] })],
    ['a bet with a missing odds', bet({ legs: [leg({ odds: undefined })] })],
    ['a bet without legs', bet({ legs: [] })],
  ])('never flags %s', (_name, row) => {
    expect(isUnusualPromotionPayout(row, '999999')).toBe(false);
  });

  it('flags a promotion-paid payout exactly when it is above stake times odds', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100_000 }),
        fc.integer({ min: 100, max: 5000 }),
        fc.integer({ min: 0, max: 5_000_000 }),
        (stake, odds, payout) => {
          const flagged = isUnusualPromotionPayout(
            { cashStake: '0', stake: money(stake), legs: [leg({ odds: money(odds) })] },
            money(payout),
          );
          expect(flagged).toBe(payout * 100 > stake * odds);
        },
      ),
    );
  });
});

describe('oddsDirection', () => {
  it.each([
    ['rising', '2.00', '2.10', 1],
    ['falling', '2.00', '1.99', -1],
    ['holding', '2.00', '2.0', 0],
    ['holding with trailing zeros', '2', '2.000', 0],
  ])('is %s', (_name, was, now, expected) => {
    expect(oddsDirection([leg({ odds: was })], [leg({ odds: now })])).toBe(expected);
  });

  it('is null when either odds is not decimal', () => {
    expect(oddsDirection([leg({ odds: 'evs' })], [leg({ odds: '2.0' })])).toBeNull();
    expect(oddsDirection([leg({ odds: '2.0' })], [leg({ odds: '-2' })])).toBeNull();
  });

  it('skips a leg whose odds is missing on either side', () => {
    expect(
      oddsDirection(
        [leg({ odds: undefined }), leg({ eventId: 'e2', odds: '2' })],
        [leg({ odds: '9' }), leg({ eventId: 'e2', odds: '3' })],
      ),
    ).toBe(1);
  });

  it('skips a reserved leg the accepted bet no longer has', () => {
    expect(
      oddsDirection(
        [leg({ odds: '2' }), leg({ eventId: 'e2', odds: '3' })],
        [leg({ odds: '2.5' })],
      ),
    ).toBe(1);
  });

  it('compares the combined odds of several legs', () => {
    expect(
      oddsDirection(
        [leg({ odds: '2' }), leg({ eventId: 'e2', odds: '3' })],
        [leg({ odds: '3' }), leg({ eventId: 'e2', odds: '2' })],
      ),
    ).toBe(0);
  });

  it('is antisymmetric and zero against itself', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(oddsCents, oddsCents), { minLength: 1, maxLength: 4 }),
        (pairs) => {
          const before = pairs.map(([odds], i) => leg({ eventId: `e${i}`, odds }));
          const after = pairs.map(([, odds], i) => leg({ eventId: `e${i}`, odds }));
          expect(oddsDirection(before, before)).toBe(0);
          expect(oddsDirection(before, after)).toBe(0 - (oddsDirection(after, before) ?? NaN));
        },
      ),
    );
  });

  it('agrees with the integer product of the odds', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(fc.integer({ min: 100, max: 5000 }), fc.integer({ min: 100, max: 5000 })),
          {
            minLength: 1,
            maxLength: 4,
          },
        ),
        (pairs) => {
          const before = pairs.map(([o], i) => leg({ eventId: `e${i}`, odds: money(o) }));
          const after = pairs.map(([, o], i) => leg({ eventId: `e${i}`, odds: money(o) }));
          const product = (side: 0 | 1) => pairs.reduce((p, pair) => p * BigInt(pair[side]), 1n);
          const expected = Math.sign(Number(product(1) - product(0)));
          expect(oddsDirection(before, after)).toBe(expected);
        },
      ),
    );
  });
});

describe('invalidTerms', () => {
  const bet = (over: Partial<Parameters<typeof invalidTerms>[0]> = {}) => ({
    cashStake: '10',
    potentialPayout: '20',
    currencyDecimals: 2,
    legs: [leg()],
    promotionType: null,
    promotionPotential: null,
    ...over,
  });

  it('accepts no terms', () => {
    expect(invalidTerms(bet(), {})).toEqual([]);
  });

  it('refuses a promotion part without the pair', () => {
    expect(invalidTerms(bet(), { promotionPotential: '1' })).toEqual(['promotionPotential']);
  });

  it('reports a dropped leg', () => {
    expect(
      invalidTerms(bet({ legs: [leg(), leg({ eventId: 'e2' })] }), {
        legs: [leg()],
        potentialPayout: '20',
      }),
    ).toContain('legs');
  });

  it('refuses a changed promotion part when the odds text changes but their value holds', () => {
    expect(
      invalidTerms(bet({ promotionType: 'boost', promotionPotential: '1' }), {
        legs: [leg({ odds: '2.0' })],
        potentialPayout: '20',
        promotionPotential: '2',
      }),
    ).toEqual(['promotionPotential']);
  });

  it('refuses a promotion part on a bet without a promotion even when the odds moved', () => {
    expect(
      invalidTerms(bet(), {
        legs: [leg({ odds: '2.50' })],
        potentialPayout: '25',
        promotionPotential: '1',
      }),
    ).toEqual(['promotionPotential']);
  });

  it('asks for the missing half of the pair', () => {
    expect(invalidTerms(bet(), { potentialPayout: '20' })).toEqual(['legs']);
    expect(invalidTerms(bet(), { legs: [leg()] })).toEqual(['potentialPayout']);
  });

  it.each([
    ['same odds, same payout', '2.00', '20', []],
    ['same odds, higher payout', '2.00', '21', ['potentialPayout']],
    ['same odds, lower payout', '2.00', '19', ['potentialPayout']],
    ['higher odds, higher payout', '2.50', '25', []],
    ['higher odds, same payout', '2.50', '20', ['potentialPayout']],
    ['higher odds, lower payout', '2.50', '15', ['potentialPayout']],
    ['lower odds, lower payout', '1.50', '15', []],
    ['lower odds, same payout', '1.50', '20', ['potentialPayout']],
    ['lower odds, higher payout', '1.50', '25', ['potentialPayout']],
    ['payout below the cash stake', '1.50', '9.99', ['potentialPayout']],
    ['payout with too many decimals', '2.50', '25.001', ['potentialPayout']],
    ['non-decimal odds text change, any payout', 'evs', '33', []],
  ])('%s', (_name, odds, payout, expected) => {
    expect(invalidTerms(bet(), { potentialPayout: payout, legs: [leg({ odds })] })).toEqual(
      expected,
    );
  });

  it('accepts a payout equal to what the player staked in cash', () => {
    expect(invalidTerms(bet(), { potentialPayout: '10', legs: [leg({ odds: '1.00' })] })).toEqual(
      [],
    );
  });

  it('lets a non-decimal odds hold only when the payout holds', () => {
    const row = bet({ legs: [leg({ odds: 'evs' })] });
    expect(invalidTerms(row, { potentialPayout: '20', legs: [leg({ odds: 'evs' })] })).toEqual([]);
    expect(invalidTerms(row, { potentialPayout: '21', legs: [leg({ odds: 'evs' })] })).toEqual([
      'potentialPayout',
    ]);
  });

  it('flags legs that change anything but their odds', () => {
    expect(
      invalidTerms(bet(), { potentialPayout: '20', legs: [leg({ eventId: 'other' })] }),
    ).toEqual(['legs']);
    expect(
      invalidTerms(bet(), { potentialPayout: '20', legs: [leg({ selection: 'draw' })] }),
    ).toEqual(['legs']);
    expect(
      invalidTerms(bet(), { potentialPayout: '20', legs: [leg(), leg({ eventId: 'e2' })] }),
    ).toEqual(['legs']);
  });

  it('flags legs whose odds appear or disappear', () => {
    expect(
      invalidTerms(bet(), { potentialPayout: '20', legs: [leg({ odds: undefined })] }),
    ).toEqual(['legs']);
  });

  it.each([
    ['set to missing', [leg({ odds: '2.00' }), leg({ eventId: 'e2', odds: undefined })]],
    ['missing to set', [leg({ odds: '2.00' }), leg({ eventId: 'e2', odds: '3.00' })]],
  ])('flags the second leg of two when its odds goes %s', (name, legs) => {
    const row = bet({
      legs: [
        leg({ odds: '2.00' }),
        leg({ eventId: 'e2', odds: name === 'set to missing' ? '3.00' : undefined }),
      ],
    });
    expect(invalidTerms(row, { potentialPayout: '20', legs })).toEqual(['legs']);
  });

  it('follows a payout move when only one of several non-decimal legs changes its odds text', () => {
    const row = bet({ legs: [leg({ odds: 'evs' }), leg({ eventId: 'e2', odds: '2.00' })] });
    const legs = [leg({ odds: 'evs' }), leg({ eventId: 'e2', odds: '2.50' })];
    expect(invalidTerms(row, { potentialPayout: '25', legs })).toEqual([]);
  });

  it('refuses a payout move when no leg changes its odds text and the direction is unknown', () => {
    const row = bet({ legs: [leg({ odds: 'evs' }), leg({ eventId: 'e2', odds: '2.00' })] });
    expect(invalidTerms(row, { potentialPayout: '25', legs: row.legs })).toEqual([
      'potentialPayout',
    ]);
  });

  it('reports only legs when a leg identity changes and the payout is otherwise valid', () => {
    expect(
      invalidTerms(bet(), { potentialPayout: '30', legs: [leg({ eventId: 'other' })] }),
    ).toEqual(['legs']);
  });

  it('treats a start time in another offset as the same leg', () => {
    expect(
      invalidTerms(bet(), {
        potentialPayout: '20',
        legs: [leg({ startsAt: '2026-03-01T14:00:00.000+02:00' })],
      }),
    ).toEqual([]);
  });

  describe('promotion part', () => {
    const boosted = bet({ promotionType: 'boost', promotionPotential: '5' });

    it('refuses one on a bet with no promotion', () => {
      expect(
        invalidTerms(bet(), { potentialPayout: '20', legs: [leg()], promotionPotential: '5' }),
      ).toEqual(['promotionPotential']);
    });

    it('accepts the stored one when the odds hold', () => {
      expect(
        invalidTerms(boosted, { potentialPayout: '20', legs: [leg()], promotionPotential: '5' }),
      ).toEqual([]);
    });

    it('refuses a changed one when the odds hold', () => {
      expect(
        invalidTerms(boosted, { potentialPayout: '20', legs: [leg()], promotionPotential: '6' }),
      ).toEqual(['promotionPotential']);
    });

    it('accepts a changed one when the odds moved', () => {
      expect(
        invalidTerms(boosted, {
          potentialPayout: '25',
          legs: [leg({ odds: '2.50' })],
          promotionPotential: '6',
        }),
      ).toEqual([]);
    });

    it('refuses one above the new payout', () => {
      expect(
        invalidTerms(boosted, {
          potentialPayout: '15',
          legs: [leg({ odds: '1.50' })],
          promotionPotential: '16',
        }),
      ).toEqual(['promotionPotential']);
    });

    it('requires a new one once the stored one no longer fits the payout', () => {
      expect(
        invalidTerms(bet({ promotionType: 'boost', promotionPotential: '18' }), {
          potentialPayout: '15',
          legs: [leg({ odds: '1.50' })],
        }),
      ).toEqual(['promotionPotential']);
    });

    it('refuses one with too many decimals', () => {
      expect(
        invalidTerms(boosted, {
          potentialPayout: '25',
          legs: [leg({ odds: '2.50' })],
          promotionPotential: '5.001',
        }),
      ).toEqual(['promotionPotential']);
    });

    it('accepts a changed one when a non-decimal odds text changed', () => {
      const row = bet({
        promotionType: 'boost',
        promotionPotential: '5',
        legs: [leg({ odds: 'evs' })],
      });
      expect(
        invalidTerms(row, {
          potentialPayout: '25',
          legs: [leg({ odds: 'sp' })],
          promotionPotential: '6',
        }),
      ).toEqual([]);
    });

    it('refuses a changed one when a non-decimal odds text held', () => {
      const row = bet({
        promotionType: 'boost',
        promotionPotential: '5',
        legs: [leg({ odds: 'evs' })],
      });
      expect(
        invalidTerms(row, {
          potentialPayout: '20',
          legs: [leg({ odds: 'evs' })],
          promotionPotential: '6',
        }),
      ).toEqual(['promotionPotential']);
    });

    it('refuses a first one on a promotion bet that had none when the odds hold', () => {
      expect(
        invalidTerms(bet({ promotionType: 'boost' }), {
          potentialPayout: '20',
          legs: [leg()],
          promotionPotential: '5',
        }),
      ).toEqual(['promotionPotential']);
    });
  });
});
