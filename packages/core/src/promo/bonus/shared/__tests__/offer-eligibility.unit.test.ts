import { describe, expect, it } from 'vitest';
import { offerIneligibility, type OfferEligibilityInput } from '../offer-eligibility.js';

type Offer = OfferEligibilityInput['offer'];

const AT = new Date('2026-06-15T12:00:00.000Z');

const offer = (over: Partial<Offer>): Offer => ({
  status: 'active',
  currency: 'USDT',
  minDeposit: '10',
  rules: { firstDepositOnly: false },
  validFrom: null,
  validUntil: null,
  ...over,
});

describe('offerIneligibility', () => {
  it.each(['draft', 'paused', 'archived'] as const)('rejects a %s offer', (status) => {
    expect(offerIneligibility({ offer: offer({ status }), at: AT })).toBe('offer_inactive');
  });

  it('accepts an active offer with no facts beyond the time', () => {
    expect(offerIneligibility({ offer: offer({}), at: AT })).toBeNull();
  });

  it.each([
    [
      'one ms before validFrom',
      { validFrom: '2026-06-15T12:00:00.001Z' },
      'outside_validity_window',
    ],
    ['exactly at validFrom', { validFrom: '2026-06-15T12:00:00.000Z' }, null],
    [
      'one ms after validUntil',
      { validUntil: '2026-06-15T11:59:59.999Z' },
      'outside_validity_window',
    ],
    ['exactly at validUntil', { validUntil: '2026-06-15T12:00:00.000Z' }, null],
    [
      'inside the window',
      { validFrom: '2026-06-01T00:00:00.000Z', validUntil: '2026-07-01T00:00:00.000Z' },
      null,
    ],
  ] as const)('%s', (_name, window, expected) => {
    expect(offerIneligibility({ offer: offer(window), at: AT })).toBe(expected);
  });

  it.each([
    ['unknown', undefined, 'not_first_deposit'],
    ['false', false, 'not_first_deposit'],
    ['true', true, null],
  ])('first-deposit-only offer with isFirstDeposit %s', (_name, isFirstDeposit, expected) => {
    expect(
      offerIneligibility({
        offer: offer({ rules: { firstDepositOnly: true } }),
        at: AT,
        isFirstDeposit,
      }),
    ).toBe(expected);
  });

  it.each([
    ['other currency', { amount: '100', currency: 'BTC' }, 'currency_mismatch'],
    [
      'below the minimum',
      { amount: '9.999999999999999999', currency: 'USDT' },
      'below_minimum_deposit',
    ],
    ['exactly the minimum', { amount: '10', currency: 'USDT' }, null],
    ['above the minimum', { amount: '10.5', currency: 'USDT' }, null],
  ])('deposit with %s', (_name, deposit, expected) => {
    expect(offerIneligibility({ offer: offer({}), at: AT, deposit })).toBe(expected);
  });

  it('reports inactive before any other failing rule', () => {
    expect(
      offerIneligibility({
        offer: offer({ status: 'paused', validUntil: '2020-01-01T00:00:00.000Z' }),
        at: AT,
        deposit: { amount: '0', currency: 'BTC' },
      }),
    ).toBe('offer_inactive');
  });

  it('reports the window before first-deposit and deposit rules', () => {
    expect(
      offerIneligibility({
        offer: offer({ validUntil: '2020-01-01T00:00:00.000Z', rules: { firstDepositOnly: true } }),
        at: AT,
        deposit: { amount: '0', currency: 'BTC' },
      }),
    ).toBe('outside_validity_window');
  });

  it('reports first-deposit before currency and minimum', () => {
    expect(
      offerIneligibility({
        offer: offer({ rules: { firstDepositOnly: true } }),
        at: AT,
        isFirstDeposit: false,
        deposit: { amount: '0', currency: 'BTC' },
      }),
    ).toBe('not_first_deposit');
  });

  it('reports currency before minimum', () => {
    expect(
      offerIneligibility({ offer: offer({}), at: AT, deposit: { amount: '0', currency: 'BTC' } }),
    ).toBe('currency_mismatch');
  });
});
