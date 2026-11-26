import { describe, expect, it } from 'vitest';
import { assertCoherentTerms, InvalidOfferTermsError, toPatch } from '../offer.service.js';

type Terms = Parameters<typeof assertCoherentTerms>[0];

const terms = (over: Partial<Terms>): Terms => ({
  wageringMultiplier: '30',
  expiryDays: 7,
  ...over,
});

describe('assertCoherentTerms', () => {
  it.each([
    ['no max bet', terms({})],
    ['a flat max bet', terms({ maxBet: '5' })],
    [
      'a rate with bounds in order',
      terms({ maxBetRate: '0.1', maxBetFloor: '1', maxBetCeiling: '5' }),
    ],
    ['equal bounds', terms({ maxBetFloor: '5', maxBetCeiling: '5' })],
    ['bounds equal after trailing zeros', terms({ maxBetFloor: '5.000', maxBetCeiling: '5' })],
  ])('accepts %s', (_name, input) => {
    expect(() => assertCoherentTerms(input)).not.toThrow();
  });

  it.each([
    ['a flat max bet and a rate together', terms({ maxBet: '5', maxBetRate: '0.1' })],
    ['a floor above the ceiling', terms({ maxBetFloor: '6', maxBetCeiling: '5' })],
    [
      'a floor above the ceiling by one smallest unit',
      terms({ maxBetFloor: '5.000000000000000001', maxBetCeiling: '5' }),
    ],
  ])('refuses %s', (_name, input) => {
    expect(() => assertCoherentTerms(input)).toThrow(InvalidOfferTermsError);
  });

  it('names the first contradiction when there are two', () => {
    expect(() =>
      assertCoherentTerms(
        terms({ maxBet: '5', maxBetRate: '0.1', maxBetFloor: '6', maxBetCeiling: '5' }),
      ),
    ).toThrow(/maxBet and maxBetRate/);
  });
});

describe('toPatch', () => {
  it('leaves both dates out when the patch does not mention them', () => {
    const patch = toPatch({ name: 'Spring reload' });
    expect(patch).toEqual({ name: 'Spring reload' });
    expect('validFrom' in patch).toBe(false);
    expect('validUntil' in patch).toBe(false);
  });

  it('clears a date with an explicit null', () => {
    expect(toPatch({ validFrom: null, validUntil: null })).toEqual({
      validFrom: null,
      validUntil: null,
    });
  });

  it('turns wire timestamps into the same instants as dates', () => {
    const patch = toPatch({
      validFrom: '2026-03-01T00:00:00.000Z',
      validUntil: '2026-03-31T23:59:59.999+02:00',
    });
    expect(patch.validFrom).toEqual(new Date('2026-03-01T00:00:00.000Z'));
    expect(patch.validUntil).toEqual(new Date('2026-03-31T21:59:59.999Z'));
  });

  it('sets one date without touching the other', () => {
    const patch = toPatch({ validUntil: '2026-03-31T00:00:00.000Z' });
    expect('validFrom' in patch).toBe(false);
    expect(patch.validUntil).toEqual(new Date('2026-03-31T00:00:00.000Z'));
  });

  it('passes money fields through untouched as exact strings', () => {
    expect(toPatch({ maxGrantAmount: '100.000000000000000001', matchPercent: '100' })).toEqual({
      maxGrantAmount: '100.000000000000000001',
      matchPercent: '100',
    });
  });
});
