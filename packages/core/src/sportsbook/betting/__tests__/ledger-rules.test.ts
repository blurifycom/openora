import { describe, expect, it } from 'vitest';
import type { SportsbookBetResult, SportsbookPromotion } from '@openora/core/contracts';
import {
  defaultPromotionAmount,
  isUnusualPromotionPayout,
  isValidPromotionAmount,
  isValidSettlement,
  requestFingerprint,
  resolveStake,
} from '../service/ledger.service.js';

const freebet: SportsbookPromotion = {
  type: 'freebet',
  stake: 'promotion',
  voidReturnsStake: false,
};
const freeMoney: SportsbookPromotion = {
  type: 'free-money',
  stake: 'promotion',
  voidReturnsStake: true,
};
const noRisk: SportsbookPromotion = { type: 'no-risk', stake: 'player', refundsLoss: true };
const boost: SportsbookPromotion = { type: 'boost', stake: 'player', refundsLoss: false };

describe('resolveStake', () => {
  it.each([
    ['no promotion', undefined, { cashStake: '5', voidPayout: '5', maxLossRefund: '0' }],
    [
      'a promotion-paid stake not returned on void',
      freebet,
      { cashStake: '0', voidPayout: '0', maxLossRefund: '0' },
    ],
    [
      'a promotion-paid stake returned on void',
      freeMoney,
      { cashStake: '0', voidPayout: '5', maxLossRefund: '0' },
    ],
    [
      'a player-paid stake without a loss refund',
      boost,
      { cashStake: '5', voidPayout: '5', maxLossRefund: '0' },
    ],
    [
      'a player-paid stake with a loss refund',
      noRisk,
      { cashStake: '5', voidPayout: '5', maxLossRefund: '5' },
    ],
  ])('resolves %s', (_label, promotion, expected) => {
    expect(resolveStake('5', promotion)).toEqual(expected);
  });
});

describe('isValidSettlement', () => {
  const bet = (promotion: SportsbookPromotion | undefined) => ({
    ...resolveStake('5', promotion),
    currencyDecimals: 2,
  });
  const cases: [string, SportsbookPromotion | undefined, SportsbookBetResult, string, boolean][] = [
    ['plain', undefined, 'void', '5', true],
    ['plain', undefined, 'void', '0', false],
    ['plain', undefined, 'lost', '0', true],
    ['plain', undefined, 'lost', '1', false],
    ['plain', undefined, 'won', '12.50', true],
    ['plain', undefined, 'won', '12.505', false],
    ['freebet', freebet, 'void', '0', true],
    ['freebet', freebet, 'void', '5', false],
    ['freebet', freebet, 'lost', '0', true],
    ['freebet', freebet, 'lost', '1', false],
    ['freebet', freebet, 'won', '12.50', true],
    ['freebet', freebet, 'half_lost', '2.50', true],
    ['free money', freeMoney, 'void', '5', true],
    ['free money', freeMoney, 'void', '0', true],
    ['free money', freeMoney, 'void', '2.50', false],
    ['free money', freeMoney, 'lost', '1', false],
    ['no-risk', noRisk, 'lost', '5', true],
    ['no-risk', noRisk, 'lost', '2.50', true],
    ['no-risk', noRisk, 'lost', '6', false],
    ['no-risk', noRisk, 'void', '5', true],
    ['no-risk', noRisk, 'half_lost', '5', true],
    ['boost', boost, 'lost', '1', false],
    ['boost', boost, 'void', '5', true],
    ['boost', boost, 'won', '30', true],
    ['boost', boost, 'cashed_out', '3.10', true],
  ];
  it.each(cases)('%s %s paying %s is %s', (_label, promotion, result, payout, valid) => {
    expect(isValidSettlement(bet(promotion), result, payout)).toBe(valid);
  });
});

describe('defaultPromotionAmount', () => {
  const cash = { cashStake: '5', promotionPotential: null, maxLossRefund: '0' };
  const boosted = { ...cash, promotionPotential: '10' };
  const noRisk = { ...cash, maxLossRefund: '5' };

  it.each([
    [
      'the whole payout of a promotion-paid stake',
      { ...cash, cashStake: '0' },
      'won',
      '12.50',
      '12.50',
    ],
    ['the refund of a lost player-paid stake', noRisk, 'lost', '5', '5'],
    ['the boost of a boosted win', boosted, 'won', '30', '10'],
    ['at most the payout of a boosted cash-out', boosted, 'cashed_out', '7', '7'],
    ['zero on a win with no boost', cash, 'won', '30', '0'],
    ['zero on a void of a player-paid stake', boosted, 'void', '5', '0'],
    ['zero on a half loss', noRisk, 'half_lost', '5', '0'],
  ] as const)('is %s', (_label, bet, result, payout, amount) => {
    expect(defaultPromotionAmount(bet, result, payout)).toBe(amount);
  });
});

describe('isValidPromotionAmount', () => {
  const plain = {
    cashStake: '5',
    promotionType: null,
    promotionPotential: null,
    maxLossRefund: '0',
    currencyDecimals: 2,
  };
  const boosted = { ...plain, promotionType: 'boost', promotionPotential: '10' };
  const noRisk = { ...plain, promotionType: 'no_risk', maxLossRefund: '10' };
  const promotionPaid = { ...plain, cashStake: '0', promotionType: 'freebet' };

  it.each([
    { bet: plain, result: 'won', payout: '10', amount: '0', valid: true },
    { bet: plain, result: 'won', payout: '10', amount: '2', valid: false },
    { bet: boosted, result: 'won', payout: '30', amount: '5', valid: true },
    { bet: boosted, result: 'won', payout: '30', amount: '10', valid: true },
    { bet: boosted, result: 'won', payout: '30', amount: '10.01', valid: false },
    { bet: boosted, result: 'cashed_out', payout: '4', amount: '5', valid: false },
    { bet: boosted, result: 'won', payout: '30', amount: '5.001', valid: false },
    { bet: boosted, result: 'void', payout: '5', amount: '5', valid: false },
    { bet: boosted, result: 'void', payout: '5', amount: '0', valid: true },
    { bet: noRisk, result: 'won', payout: '20', amount: '1', valid: false },
    { bet: noRisk, result: 'half_lost', payout: '10', amount: '5', valid: true },
    { bet: noRisk, result: 'half_lost', payout: '10', amount: '10.01', valid: false },
    { bet: boosted, result: 'half_lost', payout: '20', amount: '10', valid: true },
    { bet: boosted, result: 'half_lost', payout: '20', amount: '10.01', valid: false },
    { bet: boosted, result: 'half_won', payout: '20', amount: '10', valid: true },
    { bet: noRisk, result: 'lost', payout: '10', amount: '10', valid: true },
    { bet: promotionPaid, result: 'won', payout: '12.50', amount: '12.5', valid: true },
    { bet: promotionPaid, result: 'won', payout: '12.50', amount: '10', valid: false },
    { bet: promotionPaid, result: 'lost', payout: '0', amount: '0', valid: true },
  ] as const)(
    '$amount of a $result paying $payout on cash stake $bet.cashStake, type $bet.promotionType is $valid',
    ({ bet, result, payout, amount, valid }) => {
      expect(isValidPromotionAmount(bet, result, payout, amount)).toBe(valid);
    },
  );
});

describe('isUnusualPromotionPayout', () => {
  const leg = (odds?: string) => ({ eventId: 'e', startsAt: '2026-01-01T00:00:00Z', odds });
  const bet = (cashStake: string, ...odds: (string | undefined)[]) => ({
    cashStake,
    stake: '5',
    legs: odds.map(leg),
  });

  it('flags a promotion-paid payout above the stake times the odds product', () => {
    expect(isUnusualPromotionPayout(bet('0', '2.5', '1.2'), '15')).toBe(false);
    expect(isUnusualPromotionPayout(bet('0', '2.5', '1.2'), '15.01')).toBe(true);
  });

  it('compares with the exact product of odds finer than the money scale', () => {
    const fine = bet('0', '1.0000000000000000001');
    expect(isUnusualPromotionPayout(fine, '5.0000000000000000005')).toBe(false);
    expect(isUnusualPromotionPayout(fine, '5.000000000000000001')).toBe(true);
  });

  it('ignores a player-paid stake, missing odds and odds that are not decimals', () => {
    expect(isUnusualPromotionPayout(bet('5', '2'), '100')).toBe(false);
    expect(isUnusualPromotionPayout(bet('0', '2', undefined), '100')).toBe(false);
    expect(isUnusualPromotionPayout(bet('0', '2', '3/2'), '100')).toBe(false);
  });
});

describe('requestFingerprint', () => {
  const userId = '00000000-0000-4000-8000-000000000001';
  const reserve = {
    kind: 'reserve' as const,
    provider: 'acme-sports',
    providerBetId: 'bet-1',
    userId,
    amount: '5',
    currency: 'USD',
    potentialPayout: '12.5',
    legs: [{ eventId: 'event-1', startsAt: '2026-01-01T00:00:00.000Z', odds: '2.5' }],
  };
  const settle = {
    kind: 'settle' as const,
    provider: 'acme-sports',
    providerBetId: 'bet-1',
    userId,
    amount: '12.5',
    result: 'won',
    version: 1,
  };

  it('keeps the hash of a request that carries no promotion field', () => {
    expect(requestFingerprint(reserve)).toBe(
      '2e31abe655c8f197867715051498f48894c975612d6f2cd1f4436206de9256ce',
    );
    expect(requestFingerprint(settle)).toBe(
      'c1a500528c91222ba53e378edf28e0acfc550e56a3720ce4c68a1dc63cd951a3',
    );
  });

  it('changes the hash with each part of a declaration', () => {
    const hashes = [
      requestFingerprint(reserve),
      requestFingerprint({ ...reserve, promotion: freebet }),
      requestFingerprint({ ...reserve, promotion: { ...freebet, voidReturnsStake: true } }),
      requestFingerprint({ ...reserve, promotion: { ...freebet, type: 'other' } }),
      requestFingerprint({ ...reserve, promotion: { ...freebet, id: 'grant-1' } }),
      requestFingerprint({ ...reserve, promotion: { ...boost, potentialAmount: '5' } }),
      requestFingerprint({ ...reserve, promotion: boost }),
      requestFingerprint({ ...reserve, promotion: { ...boost, refundsLoss: true } }),
    ];
    expect(new Set(hashes).size).toBe(hashes.length);
  });

  it('changes the hash with a promotion amount, read at money scale', () => {
    const plain = requestFingerprint(settle);
    const withZero = requestFingerprint({ ...settle, promotionAmount: '0' });
    expect(withZero).not.toBe(plain);
    expect(requestFingerprint({ ...settle, promotionAmount: '2.5' })).toBe(
      requestFingerprint({ ...settle, promotionAmount: '2.500' }),
    );
  });

  it('changes the hash with a promotion potential, read at money scale', () => {
    const confirm = { kind: 'confirm' as const, provider: 'acme-sports', providerBetId: 'bet-1' };
    const withPart = requestFingerprint({ ...confirm, userId, promotionPotential: '5' });
    expect(withPart).not.toBe(requestFingerprint({ ...confirm, userId }));
    expect(withPart).toBe(requestFingerprint({ ...confirm, userId, promotionPotential: '5.00' }));
  });
});
