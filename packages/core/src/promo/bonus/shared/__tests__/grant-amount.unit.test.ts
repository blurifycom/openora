import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { moneyCompare, moneyEquals } from '@openora/core/server';
import { grantAmountFor } from '../grant-amount.js';

describe('grantAmountFor', () => {
  it.each([
    ['100', '100', '1000', '100'],
    ['100', '50', '1000', '50'],
    ['100', '200', '1000', '200'],
    ['1000', '100', '500', '500'],
    ['500', '100', '500', '500'],
    ['0', '100', '500', '0'],
    ['100', '0', '500', '0'],
    ['1000.000000000000000001', '100', '1000', '1000'],
    ['0.000000000000000001', '50', '1000', '0'],
    ['0.000000000000000003', '50', '1000', '0.000000000000000001'],
  ])('deposit %s at %s percent capped at %s grants %s', (deposit, match, cap, expected) => {
    expect(moneyEquals(grantAmountFor(deposit, match, cap), expected)).toBe(true);
  });

  const money = fc
    .bigInt({ min: 0n, max: 10n ** 27n })
    .map((u) => `${u / 10n ** 18n}.${(u % 10n ** 18n).toString().padStart(18, '0')}`);

  it('never exceeds the cap or a 100 percent match', () => {
    fc.assert(
      fc.property(money, fc.integer({ min: 0, max: 100 }), money, (deposit, p, cap) => {
        const granted = grantAmountFor(deposit, String(p), cap);
        expect(moneyCompare(granted, cap)).toBeLessThanOrEqual(0);
        expect(moneyCompare(granted, deposit)).toBeLessThanOrEqual(0);
      }),
    );
  });
});
