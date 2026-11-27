import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  WALLET_RECONCILIATION_FINDING_KINDS,
  type PaymentWebhookEvent,
  type WalletReconciliationFindingKind,
} from '@openora/core/contracts';
import { ReconciliationResolutionSchema } from '../../contract/index.js';
import {
  ReconciliationOutcomeNotAllowedError,
  assertOutcomeAllowed,
  diffDeposit,
} from '../reconciliation.service.js';

type DepositEvent = Extract<PaymentWebhookEvent, { kind: 'deposit' }>;
type Ledger = Parameters<typeof diffDeposit>[1];

const depositEvent = (amount: string, currency: string): DepositEvent =>
  ({ kind: 'deposit', amount, currency }) as unknown as DepositEvent;

const ledgerRow = (amount: string, currency: string): Ledger => ({
  id: 'tx-1' as never,
  amount,
  currency,
  network: null,
});

const SMALLEST_UNIT = '0.000000000000000001';

describe('diffDeposit', () => {
  it('reports a missing ledger row', () => {
    expect(diffDeposit(depositEvent('10', 'USDT'), undefined)).toBe('missing_deposit');
  });

  it('matches equal amounts and currencies', () => {
    expect(diffDeposit(depositEvent('10', 'USDT'), ledgerRow('10', 'USDT'))).toBeNull();
  });

  it.each([
    ['10', '10.00'],
    ['10.00', '10'],
    ['10.5', '10.500000000000000000'],
    ['0', '0.0'],
    ['0.1', '0.10'],
  ])('treats %s and %s as the same amount', (a, b) => {
    expect(diffDeposit(depositEvent(a, 'USDT'), ledgerRow(b, 'USDT'))).toBeNull();
  });

  it('flags a difference of one smallest unit', () => {
    expect(
      diffDeposit(depositEvent('10', 'USDT'), ledgerRow(`10${SMALLEST_UNIT.slice(1)}`, 'USDT')),
    ).toBe('amount_mismatch');
  });

  it('flags a different amount', () => {
    expect(diffDeposit(depositEvent('10', 'USDT'), ledgerRow('11', 'USDT'))).toBe(
      'amount_mismatch',
    );
  });

  it('compares currency case-insensitively', () => {
    expect(diffDeposit(depositEvent('1', 'usdt'), ledgerRow('1', 'USDT'))).toBeNull();
  });

  it('flags a different currency', () => {
    expect(diffDeposit(depositEvent('1', 'BTC'), ledgerRow('1', 'USDT'))).toBe('currency_mismatch');
  });

  it('reports currency before amount when both differ', () => {
    expect(diffDeposit(depositEvent('1', 'BTC'), ledgerRow('2', 'USDT'))).toBe('currency_mismatch');
  });

  it('is never mismatched against an identical amount in any trailing-zero notation', () => {
    const amount = fc
      .tuple(fc.nat({ max: 1_000_000 }), fc.nat({ max: 999_999 }), fc.nat({ max: 12 }))
      .map(([whole, frac, zeros]) => ({
        canonical: `${whole}.${String(frac).padStart(6, '0')}`,
        padded: `${whole}.${String(frac).padStart(6, '0')}${'0'.repeat(zeros)}`,
      }));
    fc.assert(
      fc.property(amount, ({ canonical, padded }) => {
        expect(diffDeposit(depositEvent(canonical, 'ETH'), ledgerRow(padded, 'eth'))).toBeNull();
      }),
    );
  });
});

const outcomes = ReconciliationResolutionSchema.options.map((option) => option.shape.outcome.value);
type Outcome = (typeof outcomes)[number];

const DISMISS_ONLY: readonly WalletReconciliationFindingKind[] = [
  'stuck_withdrawal_requested',
  'stuck_withdrawal_approved',
  'stuck_withdrawal_processing',
  'ledger_request_mismatch',
  'ledger_unrequested_transaction',
  'rg_limit_breach',
  'stuck_sweep',
  'unconfigured_asset',
  'play_eligibility_drift',
  'rg_limits_drift',
  'outbox_relay_lag',
  'event_dead_letters',
];
const LEDGER: readonly WalletReconciliationFindingKind[] = [
  'ledger_invariant_breach',
  'ledger_invariant_unchecked',
];
const REFUNDABLE: readonly WalletReconciliationFindingKind[] = [
  'missing_deposit',
  'unattributed_deposit',
  'below_minimum_deposit',
];

const expectedOutcomes = (kind: WalletReconciliationFindingKind): readonly Outcome[] => {
  if (kind === 'held_deposit') {
    return ['released', 'refunded'];
  }
  if (DISMISS_ONLY.includes(kind)) {
    return ['dismissed'];
  }
  if (LEDGER.includes(kind)) {
    return ['rebaselined', 'dismissed'];
  }
  return REFUNDABLE.includes(kind)
    ? ['credited', 'dismissed', 'refunded']
    : ['credited', 'dismissed'];
};

describe('assertOutcomeAllowed', () => {
  it('knows every kind the tables name', () => {
    for (const kind of [...DISMISS_ONLY, ...LEDGER, ...REFUNDABLE, 'held_deposit' as const]) {
      expect(WALLET_RECONCILIATION_FINDING_KINDS).toContain(kind);
    }
  });

  it('derives the five outcomes from the contract', () => {
    expect([...outcomes].sort()).toEqual(
      ['credited', 'dismissed', 'rebaselined', 'refunded', 'released'].sort(),
    );
  });

  describe.each(WALLET_RECONCILIATION_FINDING_KINDS)('%s', (kind) => {
    const allowed = expectedOutcomes(kind);
    it.each(outcomes)('%s', (outcome) => {
      const run = () => assertOutcomeAllowed(kind, outcome);
      if (allowed.includes(outcome)) {
        expect(run).not.toThrow();
      } else {
        expect(run).toThrow(ReconciliationOutcomeNotAllowedError);
      }
    });
  });

  it('refuses an outcome a kind does not allow with the default reason', () => {
    try {
      assertOutcomeAllowed('held_deposit', 'credited');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ReconciliationOutcomeNotAllowedError);
      expect((error as ReconciliationOutcomeNotAllowedError).data).toEqual({
        reason: 'outcome_not_allowed_for_kind',
      });
    }
  });

  it('never allows a credit for a refund-only or dismiss-only kind', () => {
    fc.assert(
      fc.property(fc.constantFrom(...DISMISS_ONLY, ...LEDGER, 'held_deposit' as const), (kind) => {
        expect(() => assertOutcomeAllowed(kind, 'credited')).toThrow(
          ReconciliationOutcomeNotAllowedError,
        );
      }),
    );
  });
});
