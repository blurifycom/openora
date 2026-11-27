import { describe, expect, it } from 'vitest';
import {
  isConsistentLimit,
  isConsistentLimitAmount,
  isConsistentLimitCurrency,
} from '../limits.js';

const MONEY_TYPES = ['deposit', 'wager', 'loss'] as const;
const MONEY_PERIODS = ['daily', 'weekly', 'monthly'] as const;

describe('isConsistentLimit', () => {
  it.each(MONEY_TYPES.flatMap((type) => MONEY_PERIODS.map((period) => [type, period] as const)))(
    '%s/%s is consistent',
    (type, period) => {
      expect(isConsistentLimit({ type, period })).toBe(true);
    },
  );

  it('session/session is consistent', () => {
    expect(isConsistentLimit({ type: 'session', period: 'session' })).toBe(true);
  });

  it.each(MONEY_TYPES)('%s/session is inconsistent', (type) => {
    expect(isConsistentLimit({ type, period: 'session' })).toBe(false);
  });

  it.each(MONEY_PERIODS)('session/%s is inconsistent', (period) => {
    expect(isConsistentLimit({ type: 'session', period })).toBe(false);
  });
});

describe('isConsistentLimitAmount', () => {
  it.each([
    ['session', null, 30, true],
    ['session', '10', null, false],
    ['session', '10', 30, false],
    ['session', null, null, false],
    ['deposit', '10', null, true],
    ['deposit', null, 30, false],
    ['deposit', '10', 30, false],
    ['deposit', null, null, false],
    ['loss', '0', null, true],
    ['wager', null, null, false],
  ])('%s amount=%s minutes=%s -> %s', (type, amount, minutes, expected) => {
    expect(isConsistentLimitAmount({ type, amount, minutes })).toBe(expected);
  });
});

describe('isConsistentLimitCurrency', () => {
  it.each([
    ['session', null, true],
    ['session', 'USDT', false],
    ['deposit', 'USDT', true],
    ['deposit', null, false],
    ['wager', null, false],
    ['loss', 'EUR', true],
  ])('%s currency=%s -> %s', (type, currency, expected) => {
    expect(isConsistentLimitCurrency({ type, currency })).toBe(expected);
  });
});
