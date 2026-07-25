import { describe, it, expect } from 'vitest';
import { isConsistentLimit, isConsistentLimitAmount } from '../contract/limits.js';

describe('isConsistentLimit', () => {
  it.each(['deposit', 'wager', 'loss'])('accepts a %s limit on a money period', (type) => {
    expect(isConsistentLimit({ type, period: 'daily' })).toBe(true);
  });

  it('accepts a session limit on the session period', () => {
    expect(isConsistentLimit({ type: 'session', period: 'session' })).toBe(true);
  });

  it('rejects a session limit on a money period', () => {
    expect(isConsistentLimit({ type: 'session', period: 'daily' })).toBe(false);
  });

  it('rejects a money limit on the session period', () => {
    expect(isConsistentLimit({ type: 'deposit', period: 'session' })).toBe(false);
  });
});

describe('isConsistentLimitAmount', () => {
  it('accepts a money limit carrying only an amount', () => {
    expect(isConsistentLimitAmount({ type: 'deposit', amount: '100', minutes: null })).toBe(true);
  });

  it('accepts a session limit carrying only minutes', () => {
    expect(isConsistentLimitAmount({ type: 'session', amount: null, minutes: 60 })).toBe(true);
  });

  it('rejects a money limit with no threshold at all', () => {
    expect(isConsistentLimitAmount({ type: 'deposit', amount: null, minutes: null })).toBe(false);
  });

  it('rejects a session limit with no threshold at all', () => {
    expect(isConsistentLimitAmount({ type: 'session', amount: null, minutes: null })).toBe(false);
  });

  it('rejects a money limit carrying minutes', () => {
    expect(isConsistentLimitAmount({ type: 'deposit', amount: '100', minutes: 60 })).toBe(false);
  });

  it('rejects a session limit carrying an amount', () => {
    expect(isConsistentLimitAmount({ type: 'session', amount: '100', minutes: 60 })).toBe(false);
  });

  it('rejects a money limit that only carries minutes', () => {
    expect(isConsistentLimitAmount({ type: 'wager', amount: null, minutes: 60 })).toBe(false);
  });

  it('treats a zero amount as present - the value check belongs to the schema', () => {
    expect(isConsistentLimitAmount({ type: 'deposit', amount: '0', minutes: null })).toBe(true);
  });
});
