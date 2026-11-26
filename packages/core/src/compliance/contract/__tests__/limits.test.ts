import { describe, expect, it } from 'vitest';
import {
  isConsistentLimit,
  isConsistentLimitAmount,
  isConsistentLimitCurrency,
} from '../limits.js';

describe('limit consistency', () => {
  it('a session limit with the session period is consistent', () => {
    expect(isConsistentLimit({ type: 'session', period: 'session' })).toBe(true);
  });

  it.each(['daily', 'weekly', 'monthly'])(
    'a session limit with a non-session period is inconsistent (%s)',
    (period) => {
      expect(isConsistentLimit({ type: 'session', period })).toBe(false);
    },
  );

  it.each(['deposit', 'wager', 'loss'])(
    'a non-session limit with the session period is inconsistent (%s)',
    (type) => {
      expect(isConsistentLimit({ type, period: 'session' })).toBe(false);
      expect(isConsistentLimit({ type, period: 'daily' })).toBe(true);
    },
  );

  it('a session limit with minutes and no amount is consistent', () => {
    expect(isConsistentLimitAmount({ type: 'session', amount: null, minutes: 1 })).toBe(true);
  });

  it.each([
    { amount: '10', minutes: 30 },
    { amount: '10', minutes: null },
    { amount: null, minutes: null },
  ])('a session limit with an amount or without minutes is inconsistent (%o)', (v) => {
    expect(isConsistentLimitAmount({ type: 'session', ...v })).toBe(false);
  });

  it.each(['deposit', 'wager', 'loss'])(
    'a money limit with an amount and no minutes is consistent (%s)',
    (type) => {
      expect(isConsistentLimitAmount({ type, amount: '0.01', minutes: null })).toBe(true);
    },
  );

  it.each([
    { amount: '10', minutes: 30 },
    { amount: null, minutes: 30 },
    { amount: null, minutes: null },
  ])('a money limit with minutes or without an amount is inconsistent (%o)', (v) => {
    expect(isConsistentLimitAmount({ type: 'deposit', ...v })).toBe(false);
  });

  it('a session limit with a currency is inconsistent', () => {
    expect(isConsistentLimitCurrency({ type: 'session', currency: 'BTC' })).toBe(false);
    expect(isConsistentLimitCurrency({ type: 'session', currency: null })).toBe(true);
  });

  it('a money limit without a currency is inconsistent', () => {
    expect(isConsistentLimitCurrency({ type: 'deposit', currency: null })).toBe(false);
    expect(isConsistentLimitCurrency({ type: 'deposit', currency: 'BTC' })).toBe(true);
  });
});
