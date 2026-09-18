import { describe, it, expect } from 'vitest';
import { offerIneligibility } from '../shared/offer-eligibility.js';
import { grantAmountFor } from '../shared/grant-amount.js';

const OFFER = {
  status: 'active' as const,
  currency: 'USD',
  minDeposit: '20',
  rules: { firstDepositOnly: false, excludedCountries: [] as string[] },
  validFrom: null,
  validUntil: null,
};

const AT = new Date('2026-06-01T12:00:00.000Z');

describe('who an offer is open to', () => {
  it('opens an active offer with no rules to anyone', () => {
    expect(offerIneligibility({ offer: OFFER, at: AT })).toBeNull();
  });

  it('closes an offer that is not active', () => {
    expect(offerIneligibility({ offer: { ...OFFER, status: 'paused' }, at: AT })).toBe(
      'offer_inactive',
    );
  });

  it('closes an offer before its window opens', () => {
    const offer = { ...OFFER, validFrom: '2026-07-01T00:00:00.000Z' };
    expect(offerIneligibility({ offer, at: AT })).toBe('outside_validity_window');
  });

  it('closes an offer after its window shuts', () => {
    const offer = { ...OFFER, validUntil: '2026-05-01T00:00:00.000Z' };
    expect(offerIneligibility({ offer, at: AT })).toBe('outside_validity_window');
  });

  it('opens an offer on the last moment of its window', () => {
    const offer = { ...OFFER, validUntil: AT.toISOString() };
    expect(offerIneligibility({ offer, at: AT })).toBeNull();
  });

  it('closes an offer to an excluded country', () => {
    const offer = { ...OFFER, rules: { ...OFFER.rules, excludedCountries: ['US'] } };
    expect(offerIneligibility({ offer, at: AT, countryCode: 'US' })).toBe('country_excluded');
    expect(offerIneligibility({ offer, at: AT, countryCode: 'PL' })).toBeNull();
  });

  it('closes a first-deposit offer to a caller who cannot say it is the first', () => {
    const offer = { ...OFFER, rules: { ...OFFER.rules, firstDepositOnly: true } };
    expect(offerIneligibility({ offer, at: AT })).toBe('not_first_deposit');
    expect(offerIneligibility({ offer, at: AT, isFirstDeposit: false })).toBe('not_first_deposit');
    expect(offerIneligibility({ offer, at: AT, isFirstDeposit: true })).toBeNull();
  });

  it('closes an offer to a deposit in another currency', () => {
    const deposit = { amount: '100', currency: 'EUR' };
    expect(offerIneligibility({ offer: OFFER, at: AT, deposit })).toBe('currency_mismatch');
  });

  it('closes an offer to a deposit below its minimum', () => {
    const deposit = { amount: '19.999999999999999999', currency: 'USD' };
    expect(offerIneligibility({ offer: OFFER, at: AT, deposit })).toBe('below_minimum_deposit');
  });

  it('opens an offer to a deposit of exactly its minimum', () => {
    expect(
      offerIneligibility({ offer: OFFER, at: AT, deposit: { amount: '20', currency: 'USD' } }),
    ).toBeNull();
  });
});

describe('what a deposit earns', () => {
  it('matches the deposit at the offer percentage', () => {
    expect(grantAmountFor('100', '100', '1000')).toBe('100.000000000000000000');
    expect(grantAmountFor('100', '75', '1000')).toBe('75.000000000000000000');
  });

  it('caps the match at the offer ceiling', () => {
    expect(grantAmountFor('5000', '100', '1000')).toBe('1000');
  });

  it('caps a deposit one unit over the ceiling at the ceiling', () => {
    expect(grantAmountFor('1000.000000000000000001', '100', '1000')).toBe('1000');
  });

  it('truncates rather than rounding a fractional match up', () => {
    expect(grantAmountFor('0.000000000000000001', '50', '1000')).toBe('0.000000000000000000');
  });
});
