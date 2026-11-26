import { createHash } from 'node:crypto';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import {
  SportsbookConfirmArgsSchema,
  SportsbookReserveArgsSchema,
  SportsbookSettleArgsSchema,
} from '@openora/core/contracts';
import { SPORTSBOOK_WALLET_PROVIDER_PREFIX } from '../../contract/index.js';
import type { SportsbookBetRow } from '../../schema/index.js';
import {
  ALIGN_TX_PREFIX,
  LedgerRaceLost,
  compareExact,
  fitsDecimals,
  invalidAmount,
  ledgerMismatch,
  parseRequest,
  providerRequest,
  requestFingerprint,
  timesDecimal,
  transitionRefused,
  walletRef,
} from '../ledger.service.js';

type Parts = Parameters<typeof requestFingerprint>[0];

const ONE = { digits: 1n, scale: 0 };
const PROVIDER = 'acme-sports';
const SESSION_ID = '33333333-3333-4333-8333-333333333333';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const BET_ID = '11111111-1111-4111-8111-111111111111';

const thrown = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error('expected a throw');
};

const decimalString = (units: bigint, scale: number) => {
  const digits = units.toString().padStart(scale + 1, '0');
  return scale === 0 ? digits : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
};

const decimalArb = fc
  .tuple(fc.bigInt({ min: 0n, max: 10n ** 30n }), fc.integer({ min: 0, max: 18 }))
  .map(([units, scale]) => ({ units, scale, text: decimalString(units, scale) }));

const bet = (over: Partial<SportsbookBetRow> = {}): SportsbookBetRow => ({
  id: BET_ID,
  userId: USER_ID,
  provider: PROVIDER,
  providerBetId: 'pb-1',
  sessionId: SESSION_ID,
  currency: 'USD',
  currencyDecimals: 2,
  status: 'accepted',
  result: null,
  stake: '10',
  potentialPayout: '20',
  payoutTotal: '0',
  cashStake: '10',
  voidPayout: '10',
  maxLossRefund: '0',
  promotionType: null,
  promotionId: null,
  promotionFunder: null,
  promotionPotential: null,
  promotionPaid: '0',
  version: 3,
  legs: [{ eventId: 'e1', startsAt: '2026-03-01T12:00:00.000Z', odds: '2.00' }],
  lastLegStartsAt: new Date('2026-03-01T12:00:00.000Z'),
  reconcileAttempts: 0,
  createdAt: new Date('2026-02-28T12:00:00.000Z'),
  acceptedAt: null,
  settledAt: null,
  cancelledAt: null,
  updatedAt: new Date('2026-02-28T12:00:00.000Z'),
  ...over,
});

const reserve = (over: Record<string, unknown> = {}) => ({
  provider: PROVIDER,
  providerTxId: 'tx-1',
  providerBetId: 'pb-1',
  sessionId: SESSION_ID,
  currency: 'USD',
  stake: '10',
  potentialPayout: '20',
  legs: [{ eventId: 'e1', startsAt: '2026-03-01T12:00:00.000Z', odds: '2.00' }],
  ...over,
});

describe('timesDecimal', () => {
  it.each([
    ['an integer', '2', { digits: 2n, scale: 0 }],
    ['keeps trailing zeros in the scale', '2.50', { digits: 250n, scale: 2 }],
    ['a leading zero', '0.05', { digits: 5n, scale: 2 }],
    ['18 decimals', '1.000000000000000001', { digits: 1000000000000000001n, scale: 18 }],
  ])('multiplies one by %s exactly', (_name, decimal, expected) => {
    expect(timesDecimal(ONE, decimal)).toEqual(expected);
  });

  it('chains odds without rounding the product', () => {
    expect(['1.333', '1.333', '1.333'].reduce(timesDecimal, ONE)).toEqual({
      digits: 2368593037n,
      scale: 9,
    });
  });

  it('matches a bigint product of the parsed decimals', () => {
    fc.assert(
      fc.property(decimalArb, decimalArb, (a, b) => {
        expect(timesDecimal(timesDecimal(ONE, a.text), b.text)).toEqual({
          digits: a.units * b.units,
          scale: a.scale + b.scale,
        });
      }),
    );
  });

  it('gives the same value whatever order the odds come in', () => {
    fc.assert(
      fc.property(fc.array(decimalArb, { minLength: 1, maxLength: 6 }), (odds) => {
        const texts = odds.map((o) => o.text);
        const forward = texts.reduce(timesDecimal, ONE);
        const backward = [...texts].reverse().reduce(timesDecimal, ONE);
        expect(compareExact(forward, backward)).toBe(0);
      }),
    );
  });
});

describe('compareExact', () => {
  it.each([
    ['equal values at different scales', { digits: 25n, scale: 1 }, { digits: 2500n, scale: 3 }, 0],
    ['a larger left', { digits: 1n, scale: 0 }, { digits: 999n, scale: 3 }, 1],
    ['a smaller left', { digits: 999n, scale: 3 }, { digits: 1n, scale: 0 }, -1],
    [
      'a difference past float precision',
      { digits: 10000000000000000000001n, scale: 22 },
      { digits: 1n, scale: 0 },
      1,
    ],
    ['zero against zero at any scale', { digits: 0n, scale: 0 }, { digits: 0n, scale: 18 }, 0],
  ])('%s', (_name, a, b, expected) => {
    expect(compareExact(a, b)).toBe(expected);
  });

  it('agrees with a cross-multiplied bigint model', () => {
    fc.assert(
      fc.property(decimalArb, decimalArb, (a, b) => {
        const left = a.units * 10n ** BigInt(b.scale);
        const right = b.units * 10n ** BigInt(a.scale);
        const expected = left === right ? 0 : left > right ? 1 : -1;
        expect(
          compareExact({ digits: a.units, scale: a.scale }, { digits: b.units, scale: b.scale }),
        ).toBe(expected);
      }),
    );
  });

  it('is antisymmetric', () => {
    fc.assert(
      fc.property(decimalArb, decimalArb, (a, b) => {
        const x = { digits: a.units, scale: a.scale };
        const y = { digits: b.units, scale: b.scale };
        expect(compareExact(x, y)).toBe(-compareExact(y, x) || 0);
      }),
    );
  });
});

describe('fitsDecimals', () => {
  it.each([
    ['10.12', 2, true],
    ['10.123', 2, false],
    ['10.120', 2, true],
    ['10.10000000000000000', 2, true],
    ['10', 0, true],
    ['10.5', 0, false],
    ['010.10', 2, true],
    ['0', 0, true],
    ['0.000000000000000001', 18, true],
    ['0.000000000000000001', 17, false],
    ['0.000000000000000001', 2, false],
  ])('%s at %i decimals is %s', (amount, decimals, expected) => {
    expect(fitsDecimals(amount, decimals)).toBe(expected);
  });

  it('accepts exactly the amounts with no non-zero digit past the currency decimals', () => {
    fc.assert(
      fc.property(decimalArb, fc.integer({ min: 0, max: 18 }), (a, decimals) => {
        const drop = a.scale - decimals;
        const expected = drop <= 0 || a.units % 10n ** BigInt(drop) === 0n;
        expect(fitsDecimals(a.text, decimals)).toBe(expected);
      }),
    );
  });
});

describe('requestFingerprint', () => {
  const base: Parts = {
    kind: 'reserve',
    provider: PROVIDER,
    providerBetId: 'pb-1',
    userId: USER_ID,
    amount: '10',
    potentialPayout: '20',
    currency: 'USD',
    legs: [{ eventId: 'e1', startsAt: '2026-03-01T12:00:00.000Z', odds: '2.00' }],
  };
  const fp = (over: Partial<Parts>) => requestFingerprint({ ...base, ...over });

  it('hashes a request without promotion parts exactly as the first release did', () => {
    const canonical = JSON.stringify([
      'reserve',
      PROVIDER,
      'pb-1',
      USER_ID,
      '10.000000000000000000',
      '20.000000000000000000',
      'USD',
      '',
      '',
      '',
      [[JSON.stringify(['e1', null, null, null, Date.parse('2026-03-01T12:00:00.000Z')]), '2.00']],
    ]);
    expect(fp({})).toBe(createHash('sha256').update(canonical).digest('hex'));
  });

  it('ignores the key order of the parts', () => {
    const reversed = Object.fromEntries(Object.entries(base).reverse());
    expect(
      requestFingerprint({
        ...reversed,
        kind: 'reserve',
        provider: PROVIDER,
        providerBetId: 'pb-1',
        userId: USER_ID,
      }),
    ).toBe(fp({}));
  });

  it.each([
    ['amount', { amount: '10.000' }],
    ['amount with leading zeros', { amount: '0010' }],
    ['amount at full scale', { amount: '10.000000000000000000' }],
    ['potential payout', { potentialPayout: '20.0' }],
  ])('is stable under money notation: %s', (_name, over) => {
    expect(fp(over)).toBe(fp({}));
  });

  it.each([
    ['promotion amount', { promotionAmount: '5' }, { promotionAmount: '5.00' }],
    ['promotion potential', { promotionPotential: '1.5' }, { promotionPotential: '01.50000' }],
    [
      'promotion potential amount',
      { promotion: { type: 'boost', stake: 'player', refundsLoss: false, potentialAmount: '2' } },
      {
        promotion: { potentialAmount: '2.000', refundsLoss: false, stake: 'player', type: 'boost' },
      },
    ],
  ] as const)('is stable under notation and key order: %s', (_name, a, b) => {
    expect(fp(a)).toBe(fp(b));
  });

  it('is stable when a leg names the same instant in another offset', () => {
    expect(
      fp({ legs: [{ odds: '2.00', startsAt: '2026-03-01T14:00:00+02:00', eventId: 'e1' }] }),
    ).toBe(fp({}));
  });

  it.each<[string, Partial<Parts>]>([
    ['kind', { kind: 'confirm' }],
    ['provider', { provider: 'other-sports' }],
    ['provider bet id', { providerBetId: 'pb-2' }],
    ['user id', { userId: null }],
    ['amount by one minor unit', { amount: '10.000000000000000001' }],
    ['amount removed', { amount: undefined }],
    ['amount zero', { amount: '0' }],
    ['potential payout', { potentialPayout: '20.01' }],
    ['currency', { currency: 'EUR' }],
    ['result', { result: 'won' }],
    ['cancel reason', { cancelReason: 'won' }],
    ['version', { version: 2 }],
    ['leg odds', { legs: [{ eventId: 'e1', startsAt: '2026-03-01T12:00:00.000Z', odds: '2.01' }] }],
    ['leg odds removed', { legs: [{ eventId: 'e1', startsAt: '2026-03-01T12:00:00.000Z' }] }],
    [
      'leg event',
      { legs: [{ eventId: 'e2', startsAt: '2026-03-01T12:00:00.000Z', odds: '2.00' }] },
    ],
    [
      'leg start',
      { legs: [{ eventId: 'e1', startsAt: '2026-03-01T12:00:00.001Z', odds: '2.00' }] },
    ],
    [
      'leg market',
      {
        legs: [{ eventId: 'e1', market: 'm', startsAt: '2026-03-01T12:00:00.000Z', odds: '2.00' }],
      },
    ],
    ['legs removed', { legs: undefined }],
    ['promotion amount zero', { promotionAmount: '0' }],
    ['promotion potential zero', { promotionPotential: '0' }],
    ['promotion added', { promotion: { type: 'boost', stake: 'player', refundsLoss: false } }],
  ])('changes when the %s changes', (_name, over) => {
    expect(fp(over)).not.toBe(fp({}));
  });

  it('tells a result from a cancel reason of the same text', () => {
    expect(fp({ result: 'void' })).not.toBe(fp({ cancelReason: 'void' }));
  });

  it('tells a promotion amount from a promotion potential of the same value', () => {
    expect(fp({ promotionAmount: '1' })).not.toBe(fp({ promotionPotential: '1' }));
  });

  it.each<[string, Parts['promotion'], Parts['promotion']]>([
    [
      'type',
      { type: 'boost', stake: 'player', refundsLoss: false },
      { type: 'insurance', stake: 'player', refundsLoss: false },
    ],
    [
      'id',
      { type: 'boost', stake: 'player', refundsLoss: false },
      { type: 'boost', id: 'p-1', stake: 'player', refundsLoss: false },
    ],
    [
      'refundsLoss',
      { type: 'boost', stake: 'player', refundsLoss: false },
      { type: 'boost', stake: 'player', refundsLoss: true },
    ],
    [
      'voidReturnsStake',
      { type: 'free', stake: 'promotion', voidReturnsStake: false },
      { type: 'free', stake: 'promotion', voidReturnsStake: true },
    ],
    [
      'stake side',
      { type: 'free', stake: 'promotion', voidReturnsStake: true },
      { type: 'free', stake: 'player', refundsLoss: true },
    ],
    [
      'potential amount',
      { type: 'boost', stake: 'player', refundsLoss: false, potentialAmount: '2' },
      { type: 'boost', stake: 'player', refundsLoss: false, potentialAmount: '2.01' },
    ],
  ])('changes when the promotion %s changes', (_name, a, b) => {
    expect(fp({ promotion: a })).not.toBe(fp({ promotion: b }));
  });

  it('is equal for two amounts exactly when their values are equal', () => {
    fc.assert(
      fc.property(decimalArb, decimalArb, (a, b) => {
        const sameValue =
          a.units * 10n ** BigInt(18 - a.scale) === b.units * 10n ** BigInt(18 - b.scale);
        expect(fp({ amount: a.text }) === fp({ amount: b.text })).toBe(sameValue);
      }),
    );
  });

  it('ignores trailing zeros on any amount', () => {
    fc.assert(
      fc.property(decimalArb, fc.integer({ min: 0, max: 18 }), (a, pad) => {
        const padded =
          a.scale + pad > 18
            ? a.text
            : a.scale === 0
              ? `${a.text}.${'0'.repeat(Math.max(pad, 1))}`
              : `${a.text}${'0'.repeat(pad)}`;
        expect(fp({ potentialPayout: padded })).toBe(fp({ potentialPayout: a.text }));
      }),
    );
  });
});

describe('providerRequest', () => {
  it('passes a provider id through unchanged', () => {
    const args = { provider: PROVIDER, providerTxId: 'tx-1' };
    expect(providerRequest(args)).toBe(args);
  });

  it.each(['core-align:', 'core-align:x', `core-align:${BET_ID}:v1:settle`])(
    'refuses the reserved id %s and files it',
    (providerTxId) => {
      expect(thrown(() => providerRequest({ provider: PROVIDER, providerTxId }))).toMatchObject({
        reason: 'fingerprint_mismatch',
        finding: {
          kind: 'fingerprint_mismatch',
          dedupeKey: `fingerprint_mismatch:${PROVIDER}:${providerTxId}`,
          provider: PROVIDER,
          detail: { providerTxId, reserved: true },
        },
      });
    },
  );

  it.each([
    ' core-align:x',
    'core-align:x ',
    '\tcore-align:x\n',
    ' core-align:x',
    '　core-align:x',
  ])(
    'refuses a reserved id hidden behind whitespace %j once the schema trims it',
    (providerTxId) => {
      expect(
        thrown(() =>
          providerRequest(
            parseRequest(SportsbookConfirmArgsSchema, {
              provider: PROVIDER,
              providerTxId,
              providerBetId: 'pb-1',
            }),
          ),
        ),
      ).toMatchObject({
        reason: 'fingerprint_mismatch',
        finding: { detail: { providerTxId: 'core-align:x' } },
      });
    },
  );

  it.each([
    'CORE-ALIGN:x',
    'Core-Align:x',
    'core-align-x',
    'core_align:x',
    'xcore-align:x',
    'core-align：x',
    '​core-align:x',
  ])(
    'passes %j, which no case-sensitive id match can confuse with a core align id',
    (providerTxId) => {
      const args = { provider: PROVIDER, providerTxId };
      expect(providerRequest(args)).toBe(args);
    },
  );
});

describe('parseRequest', () => {
  it('returns the parsed request with trimmed ids', () => {
    expect(
      parseRequest(
        SportsbookReserveArgsSchema,
        reserve({ providerTxId: ' tx-1 ', providerBetId: 'pb-1\n' }),
      ),
    ).toMatchObject({ providerTxId: 'tx-1', providerBetId: 'pb-1', stake: '10' });
  });

  it.each([
    ['an exponent', '1e3'],
    ['a negative', '-1'],
    ['a trailing dot', '10.'],
    ['a leading dot', '.5'],
    ['padding', ' 10'],
    ['19 decimals', '1.0000000000000000001'],
    ['a digit separator', '1_000'],
    ['hex', '0x10'],
    ['fullwidth digits', '１０'],
    ['an empty string', ''],
    ['Infinity', 'Infinity'],
    ['a number', 10],
    ['a missing value', undefined],
  ])('refuses a stake with %s as invalid_amount and files it', (_name, stake) => {
    expect(
      thrown(() =>
        parseRequest(SportsbookReserveArgsSchema, reserve({ stake, providerTxId: ' tx-1 ' })),
      ),
    ).toMatchObject({
      reason: 'invalid_amount',
      finding: {
        kind: 'invalid_amount',
        dedupeKey: `invalid_amount:${PROVIDER}:tx-1`,
        provider: PROVIDER,
        detail: {
          provider: PROVIDER,
          providerTxId: 'tx-1',
          providerBetId: 'pb-1',
          fields: ['stake'],
        },
      },
    });
  });

  it.each<[string, Record<string, unknown>, string[]]>([
    [
      'leg odds over 32 chars',
      { legs: [{ eventId: 'e1', startsAt: '2026-03-01T12:00:00Z', odds: '1'.repeat(33) }] },
      ['legs.odds'],
    ],
    [
      'numeric leg odds',
      { legs: [{ eventId: 'e1', startsAt: '2026-03-01T12:00:00Z', odds: 2.5 }] },
      ['legs.odds'],
    ],
    [
      'odds on two legs, named once',
      {
        legs: [
          { eventId: 'e1', startsAt: '2026-03-01T12:00:00Z', odds: 2 },
          { eventId: 'e2', startsAt: '2026-03-01T12:00:00Z', odds: 3 },
        ],
      },
      ['legs.odds'],
    ],
    [
      'stake and potential payout',
      { stake: '1e1', potentialPayout: '-2' },
      ['stake', 'potentialPayout'],
    ],
    [
      'a promotion potential amount',
      { promotion: { type: 'boost', stake: 'player', refundsLoss: false, potentialAmount: '1e2' } },
      ['promotion.potentialAmount'],
    ],
  ])('refuses %s as invalid_amount naming the fields', (_name, over, fields) => {
    expect(thrown(() => parseRequest(SportsbookReserveArgsSchema, reserve(over)))).toMatchObject({
      reason: 'invalid_amount',
      finding: { detail: { fields } },
    });
  });

  it.each([
    ['settle payout', SportsbookSettleArgsSchema, { result: 'won', payout: '1e2' }, ['payout']],
    [
      'settle promotion amount',
      SportsbookSettleArgsSchema,
      { result: 'won', payout: '2', promotionAmount: '1.' },
      ['promotionAmount'],
    ],
    [
      'confirm potential payout',
      SportsbookConfirmArgsSchema,
      { potentialPayout: 'NaN' },
      ['potentialPayout'],
    ],
    [
      'confirm promotion potential',
      SportsbookConfirmArgsSchema,
      { promotionPotential: '-0' },
      ['promotionPotential'],
    ],
  ])('refuses a malformed %s as invalid_amount', (_name, schema, over, fields) => {
    const input = { provider: PROVIDER, providerTxId: 'tx-1', providerBetId: 'pb-1', ...over };
    expect(thrown(() => parseRequest(schema, input))).toMatchObject({
      reason: 'invalid_amount',
      finding: { detail: { fields } },
    });
  });

  it.each([
    ['an unknown key', { type: 'boost', stake: 'player', refundsLoss: false, cap: '5' }],
    ['an unknown stake side', { type: 'boost', stake: 'house', refundsLoss: false }],
    ['a missing flag', { type: 'free', stake: 'promotion' }],
    ['the flag of the other side', { type: 'free', stake: 'promotion', refundsLoss: true }],
    ['a __proto__ type', { type: '__proto__', stake: 'player', refundsLoss: false }],
    ['a blank type', { type: '  ', stake: 'player', refundsLoss: false }],
    ['a string', 'boost'],
  ])(
    'refuses a promotion with %s as promotion_not_allowed without a finding',
    (_name, promotion) => {
      const err = thrown(() => parseRequest(SportsbookReserveArgsSchema, reserve({ promotion })));
      expect(err).toMatchObject({ reason: 'promotion_not_allowed', finding: undefined });
    },
  );

  it.each([
    ['a non-uuid session', { sessionId: 'not-a-uuid' }],
    ['a missing session', { sessionId: undefined }],
    ['a bad session and a bad stake', { sessionId: 'x', stake: '1e3' }],
  ])('refuses %s as session_invalid', (_name, over) => {
    expect(thrown(() => parseRequest(SportsbookReserveArgsSchema, reserve(over)))).toMatchObject({
      reason: 'session_invalid',
      finding: undefined,
    });
  });

  it('puts a malformed promotion before a malformed session', () => {
    expect(
      thrown(() =>
        parseRequest(
          SportsbookReserveArgsSchema,
          reserve({ sessionId: 'x', promotion: { type: 'x' } }),
        ),
      ),
    ).toMatchObject({ reason: 'promotion_not_allowed' });
  });

  it.each([
    ['no legs', { legs: [] }],
    ['a blank leg event', { legs: [{ eventId: ' ', startsAt: '2026-03-01T12:00:00Z' }] }],
    ['a leg start without offset', { legs: [{ eventId: 'e1', startsAt: '2026-03-01T12:00:00' }] }],
    ['a bad currency', { currency: '' }],
    ['an uppercase provider', { provider: 'Acme' }],
    ['a provider with a colon', { provider: 'acme:x' }],
    ['a blank tx id', { providerTxId: '   ' }],
    ['a tx id over 128 chars', { providerTxId: 'x'.repeat(129) }],
    ['a bad stake and a bad provider', { stake: '1e3', provider: 'Acme' }],
    ['a bad stake and a missing bet id', { stake: '1e3', providerBetId: undefined }],
  ])('throws the ZodError for %s', (_name, over) => {
    expect(() => parseRequest(SportsbookReserveArgsSchema, reserve(over))).toThrow(z.ZodError);
  });

  it.each([null, undefined, 'tx-1', 42, []])(
    'throws the ZodError for a non-object input %j',
    (input) => {
      expect(() => parseRequest(SportsbookReserveArgsSchema, input)).toThrow(z.ZodError);
    },
  );

  it.each([
    ['a zero expected version', { result: 'won', payout: '1', expectedVersion: 0 }],
    ['a fractional expected version', { result: 'won', payout: '1', expectedVersion: 1.5 }],
    ['an unknown result', { result: 'jackpot', payout: '1' }],
  ])('throws the ZodError for a settle with %s', (_name, over) => {
    const input = { provider: PROVIDER, providerTxId: 'tx-1', providerBetId: 'pb-1', ...over };
    expect(() => parseRequest(SportsbookSettleArgsSchema, input)).toThrow(z.ZodError);
  });
});

describe('walletRef', () => {
  it('names the sportsbook provider, a tx-prefixed ref and the bet as the round', () => {
    expect(walletRef({ provider: PROVIDER, providerTxId: 'tx-1', providerBetId: 'pb-1' })).toEqual({
      providerName: `${SPORTSBOOK_WALLET_PROVIDER_PREFIX}${PROVIDER}`,
      providerRefId: 'tx:tx-1',
      externalRoundId: 'pb-1',
    });
  });

  it('never yields a ref a debt offset or collection uses, and never one shared by two tx ids', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), fc.string({ minLength: 1 }), (a, b) => {
        const [refA, refB] = [a, b].map(
          (tx) =>
            walletRef({ provider: PROVIDER, providerTxId: tx, providerBetId: 'pb-1' })
              .providerRefId,
        );
        expect(refA?.startsWith('tx:')).toBe(true);
        expect(refA === refB).toBe(a === b);
      }),
    );
  });
});

describe('refusal builders', () => {
  const key = { provider: PROVIDER, providerTxId: 'tx-1' };

  it('files an invalid amount under its tx with no owner by default', () => {
    const refusal = invalidAmount(key, { fields: ['stake'] });
    expect(refusal).toMatchObject({
      reason: 'invalid_amount',
      finding: {
        kind: 'invalid_amount',
        dedupeKey: `invalid_amount:${PROVIDER}:tx-1`,
        provider: PROVIDER,
        detail: { providerTxId: 'tx-1', fields: ['stake'] },
      },
    });
    expect(refusal.finding).not.toHaveProperty('betId');
    expect(refusal.finding).not.toHaveProperty('userId');
  });

  it('files an invalid amount with its owner when known', () => {
    expect(invalidAmount(key, {}, { betId: BET_ID, userId: USER_ID }).finding).toMatchObject({
      betId: BET_ID,
      userId: USER_ID,
    });
  });

  it('refuses a ledger mismatch as an illegal transition filed as a provider mismatch', () => {
    expect(
      ledgerMismatch(key, { betId: BET_ID, userId: USER_ID }, { move: 'a payout' }),
    ).toMatchObject({
      reason: 'illegal_transition',
      finding: {
        kind: 'provider_mismatch',
        dedupeKey: `provider_mismatch:${PROVIDER}:tx-1`,
        provider: PROVIDER,
        betId: BET_ID,
        userId: USER_ID,
        detail: { providerTxId: 'tx-1', move: 'a payout' },
      },
    });
  });

  it('refuses a transition with the bet it found', () => {
    expect(transitionRefused(key, 'settle', bet())).toMatchObject({
      reason: 'illegal_transition',
      finding: {
        kind: 'provider_mismatch',
        dedupeKey: `provider_mismatch:${PROVIDER}:tx-1`,
        betId: BET_ID,
        userId: USER_ID,
        detail: { providerTxId: 'tx-1', requested: 'settle', betStatus: 'accepted', betVersion: 3 },
      },
    });
  });

  it('refuses a transition on a missing bet with null owner and state', () => {
    expect(transitionRefused(key, 'confirm', undefined).finding).toEqual({
      kind: 'provider_mismatch',
      dedupeKey: `provider_mismatch:${PROVIDER}:tx-1`,
      provider: PROVIDER,
      betId: null,
      userId: null,
      detail: { providerTxId: 'tx-1', requested: 'confirm', betStatus: null, betVersion: null },
    });
  });

  it('gives every provider and tx pair its own dedupe key', () => {
    const providerArb = fc.stringMatching(/^[a-z0-9][a-z0-9_-]{0,10}$/);
    fc.assert(
      fc.property(providerArb, fc.string(), providerArb, fc.string(), (p1, t1, p2, t2) => {
        const k1 = invalidAmount({ provider: p1, providerTxId: t1 }, {}).finding?.dedupeKey;
        const k2 = invalidAmount({ provider: p2, providerTxId: t2 }, {}).finding?.dedupeKey;
        expect(k1 === k2).toBe(p1 === p2 && t1 === t2);
      }),
    );
  });

  it('keeps a lost wallet race on its own dedupe key apart from any refused provider tx', () => {
    const alignTx = `${ALIGN_TX_PREFIX}${BET_ID}:v1:settle`;
    const raceLost = new LedgerRaceLost(
      'a payout',
      { provider: PROVIDER, providerTxId: alignTx, providerBetId: 'pb-1' },
      { betId: BET_ID, userId: USER_ID },
      'w-1',
    );
    const reserved = thrown(() =>
      providerRequest({ provider: PROVIDER, providerTxId: `${alignTx}:wallet_ref` }),
    );
    expect(reserved).toMatchObject({ reason: 'fingerprint_mismatch' });
    expect(reserved).not.toMatchObject({
      finding: { dedupeKey: raceLost.refusal.finding?.dedupeKey },
    });
  });
});
