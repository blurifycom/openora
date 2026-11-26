import { describe, expect, it } from 'vitest';
import { offerIneligibility, type OfferEligibilityInput } from '../offer-eligibility.js';

const open: OfferEligibilityInput['offer'] = {
  status: 'active',
  currency: 'USDT',
  minDeposit: '10',
  rules: { firstDepositOnly: false },
  validFrom: null,
  validUntil: null,
};

const at = new Date('2026-06-15T12:00:00.000Z');

describe('offerIneligibility', () => {
  it('returns offer_inactive when the offer status is not active', () => {
    for (const status of ['draft', 'paused', 'archived'] as const) {
      expect(offerIneligibility({ offer: { ...open, status }, at })).toBe('offer_inactive');
    }
  });

  it('returns outside_validity_window before the start', () => {
    const offer = { ...open, validFrom: '2026-06-15T12:00:00.001Z' };
    expect(offerIneligibility({ offer, at })).toBe('outside_validity_window');
  });

  it('returns outside_validity_window after the end', () => {
    const offer = { ...open, validUntil: '2026-06-15T11:59:59.999Z' };
    expect(offerIneligibility({ offer, at })).toBe('outside_validity_window');
  });

  it('accepts the instant at the start and at the end of the window', () => {
    const offer = {
      ...open,
      validFrom: '2026-06-15T12:00:00.000Z',
      validUntil: '2026-06-15T12:00:00.000Z',
    };
    expect(offerIneligibility({ offer, at })).toBeNull();
  });

  it('returns not_first_deposit for a first-deposit-only offer when the fact is false or absent', () => {
    const offer = { ...open, rules: { firstDepositOnly: true } };
    expect(offerIneligibility({ offer, at, isFirstDeposit: false })).toBe('not_first_deposit');
    expect(offerIneligibility({ offer, at })).toBe('not_first_deposit');
    expect(offerIneligibility({ offer, at, isFirstDeposit: true })).toBeNull();
  });

  it('returns null when no deposit is supplied and the offer is open', () => {
    expect(offerIneligibility({ offer: open, at })).toBeNull();
  });

  it('returns currency_mismatch when the deposit currency differs', () => {
    expect(
      offerIneligibility({ offer: open, at, deposit: { amount: '100', currency: 'BTC' } }),
    ).toBe('currency_mismatch');
  });

  it('returns below_minimum_deposit under the minimum', () => {
    expect(
      offerIneligibility({
        offer: open,
        at,
        deposit: { amount: '9.999999999999999999', currency: 'USDT' },
      }),
    ).toBe('below_minimum_deposit');
  });

  it('returns null for a deposit exactly at the minimum', () => {
    expect(
      offerIneligibility({ offer: open, at, deposit: { amount: '10', currency: 'USDT' } }),
    ).toBeNull();
  });
});
