import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { SportsbookProviderBetStatus } from '@openora/core/contracts';
import { alignmentSteps } from '../align.service.js';
import { ALIGN_TX_PREFIX } from '../ledger.service.js';
import type { SportsbookBetRow } from '../../schema/index.js';

const BET_ID = '11111111-1111-4111-8111-111111111111';

const bet = (over: Partial<SportsbookBetRow> = {}): SportsbookBetRow => ({
  id: BET_ID,
  userId: '22222222-2222-4222-8222-222222222222',
  provider: 'acme-sports',
  providerBetId: 'pb-1',
  sessionId: '33333333-3333-4333-8333-333333333333',
  currency: 'USD',
  currencyDecimals: 2,
  status: 'reserved',
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
  version: 1,
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

const key = { provider: 'acme-sports', providerBetId: 'pb-1' };
const id = (version: number, kind: string) => `${ALIGN_TX_PREFIX}${BET_ID}:v${version}:${kind}`;

const won = { status: 'settled', result: 'won', payout: '20' } as const;
const lost = { status: 'settled', result: 'lost', payout: '0' } as const;
const pending = { status: 'pending' } as const;
const accepted = { status: 'accepted' } as const;
const rejected = { status: 'rejected' } as const;
const notFound = { status: 'not_found' } as const;

const settleStep = (version: number, over: Record<string, unknown> = {}) => ({
  kind: 'settle',
  args: {
    ...key,
    providerTxId: id(version, 'settle'),
    result: 'won',
    payout: '20',
    promotionAmount: undefined,
    expectedVersion: version,
    ...over,
  },
});
const confirmStep = (version: number) => ({
  kind: 'confirm',
  args: { ...key, providerTxId: id(version, 'confirm') },
});
const reopenStep = (version: number) => ({
  kind: 'reopen',
  args: { ...key, providerTxId: id(version, 'reopen'), expectedVersion: version },
});
const cancelStep = (version: number, reason: string) => ({
  kind: 'cancel',
  args: { ...key, providerTxId: id(version, 'cancel'), reason },
});

const noop = { steps: [], mismatch: false };
const mismatch = { steps: [], mismatch: true };
const apply = (steps: unknown[]) => ({ steps, mismatch: false });

describe('alignmentSteps', () => {
  it.each([['reserved'], ['accepted'], ['settled'], ['cancelled']] as const)(
    'does nothing while the provider reports pending on a %s bet',
    (status) => {
      expect(alignmentSteps(bet({ status }), pending)).toEqual(noop);
    },
  );

  describe('reserved bet', () => {
    it.each([
      ['rejected', rejected, apply([cancelStep(1, 'rejected')])],
      ['not found', notFound, apply([cancelStep(1, 'discarded')])],
      ['accepted', accepted, apply([confirmStep(1)])],
      ['settled won', won, apply([confirmStep(1), settleStep(1)])],
      [
        'settled lost',
        lost,
        apply([confirmStep(1), settleStep(1, { result: 'lost', payout: '0' })]),
      ],
    ])('provider says %s', (_name, observed, expected) => {
      expect(alignmentSteps(bet({ status: 'reserved' }), observed)).toEqual(expected);
    });
  });

  describe('accepted bet', () => {
    it.each([
      ['accepted', accepted, noop],
      ['rejected', rejected, mismatch],
      ['not found', notFound, mismatch],
      ['settled won', won, apply([settleStep(1)])],
    ])('provider says %s', (_name, observed, expected) => {
      expect(alignmentSteps(bet({ status: 'accepted' }), observed)).toEqual(expected);
    });
  });

  describe('settled bet', () => {
    const settled = bet({
      status: 'settled',
      result: 'won',
      payoutTotal: '20',
      promotionPaid: '0',
      version: 3,
    });

    it.each([
      ['accepted', accepted, apply([reopenStep(3)])],
      ['rejected', rejected, mismatch],
      ['not found', notFound, mismatch],
      ['the same settlement', won, noop],
      ['the same settlement with a promotion part of zero', { ...won, promotionAmount: '0' }, noop],
      [
        'the same settlement with a promotion part moved',
        { ...won, promotionAmount: '5' },
        mismatch,
      ],
      [
        'another result',
        { status: 'settled', result: 'lost', payout: '0' },
        apply([reopenStep(3), settleStep(4, { result: 'lost', payout: '0' })]),
      ],
      [
        'another result at the same payout',
        { status: 'settled', result: 'half_won', payout: '20' },
        apply([reopenStep(3), settleStep(4, { result: 'half_won', payout: '20' })]),
      ],
      [
        'the same result at another payout',
        { status: 'settled', result: 'won', payout: '21' },
        apply([reopenStep(3), settleStep(4, { payout: '21' })]),
      ],
    ] satisfies [string, SportsbookProviderBetStatus, unknown][])(
      'provider says %s',
      (_name, observed, expected) => {
        expect(alignmentSteps(settled, observed)).toEqual(expected);
      },
    );

    describe('on a promotion bet that paid a promotion part', () => {
      const promoted = bet({
        status: 'settled',
        result: 'won',
        payoutTotal: '20',
        promotionType: 'boost',
        promotionPotential: '5',
        promotionPaid: '5',
        version: 3,
      });

      it.each([
        ['the same promotion part', { ...won, promotionAmount: '5' }, noop],
        ['no promotion part', won, noop],
        ['another promotion part', { ...won, promotionAmount: '4' }, mismatch],
        ['a zero promotion part', { ...won, promotionAmount: '0' }, mismatch],
      ] satisfies [string, SportsbookProviderBetStatus, unknown][])(
        'provider says %s',
        (_name, observed, expected) => {
          expect(alignmentSteps(promoted, observed)).toEqual(expected);
        },
      );
    });

    it('treats a payout equal in value but not in text as the same settlement', () => {
      expect(alignmentSteps(settled, { ...won, payout: '20.00' })).toEqual(noop);
    });
  });

  describe('cancelled bet', () => {
    it.each([
      ['rejected', rejected, noop],
      ['not found', notFound, noop],
      ['accepted', accepted, mismatch],
      ['settled', won, mismatch],
    ])('provider says %s', (_name, observed, expected) => {
      expect(alignmentSteps(bet({ status: 'cancelled' }), observed)).toEqual(expected);
    });
  });

  describe('a settlement the bet cannot take', () => {
    it.each([
      ['a payout with too many decimals', { ...won, payout: '1.005' }],
      ['a void at the wrong amount', { status: 'settled', result: 'void', payout: '3' }],
      ['a loss above the refund cap', { status: 'settled', result: 'lost', payout: '1' }],
      ['a promotion part above its ceiling', { ...won, promotionAmount: '1' }],
    ] satisfies [string, SportsbookProviderBetStatus][])(
      'is a mismatch for %s',
      (_name, observed) => {
        for (const status of ['reserved', 'accepted', 'settled', 'cancelled'] as const) {
          expect(alignmentSteps(bet({ status }), observed)).toEqual(mismatch);
        }
      },
    );
  });

  describe('determinism', () => {
    const statuses = ['reserved', 'accepted', 'settled', 'cancelled'] as const;
    const observations: SportsbookProviderBetStatus[] = [
      pending,
      accepted,
      rejected,
      notFound,
      won,
      lost,
    ];

    it('gives the same steps and transaction ids for the same input twice', () => {
      fc.assert(
        fc.property(
          fc.constantFrom(...statuses),
          fc.constantFrom(...observations),
          fc.integer({ min: 1, max: 50 }),
          (status, observed, version) => {
            const row = bet({ status, version, result: 'won', payoutTotal: '20' });
            expect(alignmentSteps(row, observed)).toEqual(alignmentSteps(row, observed));
          },
        ),
      );
    });

    it('keys every transaction id by bet id, version and kind under the core prefix', () => {
      fc.assert(
        fc.property(
          fc.constantFrom(...statuses),
          fc.constantFrom(...observations),
          fc.integer({ min: 1, max: 50 }),
          (status, observed, version) => {
            const row = bet({ status, version, result: 'won', payoutTotal: '20' });
            const { steps } = alignmentSteps(row, observed);
            const ids = steps.map((step) => step.args.providerTxId);
            expect(new Set(ids).size).toBe(ids.length);
            for (const step of steps) {
              expect(step.args.providerTxId.startsWith(`${ALIGN_TX_PREFIX}${BET_ID}:v`)).toBe(true);
              expect(step.args.providerTxId.endsWith(`:${step.kind}`)).toBe(true);
            }
          },
        ),
      );
    });

    it('moves a re-settle to the next version so it never replays the old settle transaction', () => {
      const row = bet({ status: 'settled', result: 'won', payoutTotal: '20', version: 7 });
      const { steps } = alignmentSteps(row, lost);
      expect(steps.map((step) => step.args.providerTxId)).toEqual([
        id(7, 'reopen'),
        id(8, 'settle'),
      ]);
    });
  });
});
