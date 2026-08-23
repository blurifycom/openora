import { describe, it, expect } from 'vitest';
import { diffDeposit } from '../service/reconciliation.service.js';

const depositEvent = (over: Partial<Parameters<typeof diffDeposit>[0]> = {}) => ({
  kind: 'deposit' as const,
  address: 'bc1qxyz',
  amount: '1',
  currency: 'BTC',
  txHash: '0xabc',
  externalId: 'vendor-ext-1',
  ...over,
});

const ledgerRow = (
  over: Partial<{ id: string; currency: string; amount: string; network: string | null }> = {},
) => ({
  id: 'tx-1',
  currency: 'BTC',
  amount: '1',
  network: null,
  ...over,
});

describe('diffDeposit', () => {
  it('flags missing_deposit when no ledger row matches the vendor event', () => {
    expect(diffDeposit(depositEvent(), undefined)).toBe('missing_deposit');
  });

  it('flags currency_mismatch when the ledger row settled in a different currency', () => {
    const event = depositEvent({ currency: 'ETH' });
    const tx = ledgerRow({ currency: 'BTC' });

    expect(diffDeposit(event, tx)).toBe('currency_mismatch');
  });

  it('flags currency_mismatch case-insensitively as a genuine mismatch, not a false positive', () => {
    const event = depositEvent({ currency: 'btc' });
    const tx = ledgerRow({ currency: 'BTC' });

    expect(diffDeposit(event, tx)).toBeNull();
  });

  it('flags amount_mismatch when the currencies agree but the amounts differ', () => {
    const event = depositEvent({ amount: '2' });
    const tx = ledgerRow({ amount: '1' });

    expect(diffDeposit(event, tx)).toBe('amount_mismatch');
  });

  it('never routes an amount compare through float - "1" and "1.00" reconcile exactly', () => {
    const event = depositEvent({ amount: '1.00' });
    const tx = ledgerRow({ amount: '1' });

    expect(diffDeposit(event, tx)).toBeNull();
  });

  it('reconciles (returns null) when currency and amount both match', () => {
    const event = depositEvent();
    const tx = ledgerRow();

    expect(diffDeposit(event, tx)).toBeNull();
  });
});
