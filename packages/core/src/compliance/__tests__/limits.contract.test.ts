import { describe, it, expect } from 'vitest';
import { isConsistentLimit, isConsistentLimitAmount, LimitViewSchema } from '../contract/limits.js';

const baseView = {
  id: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
  type: 'deposit' as const,
  amount: '100.00',
  minutes: null,
  currency: 'USD',
  period: 'daily' as const,
  createdAt: new Date().toISOString(),
  pct: 80,
  pendingKind: null,
  pendingAmount: null,
  pendingMinutes: null,
  pendingCurrency: null,
  pendingStatus: null,
  pendingEffectiveAt: null,
  pendingExpiresAt: null,
};

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

describe('LimitViewSchema used/remaining scale', () => {
  it('accepts used/remaining at the limit amount scale', () => {
    const result = LimitViewSchema.safeParse({ ...baseView, used: '80.00', remaining: '20.00' });
    expect(result.success).toBe(true);
  });

  it('accepts used/remaining at full MONEY_SCALE(18) precision', () => {
    const result = LimitViewSchema.safeParse({
      ...baseView,
      used: '33.336000000000000000',
      remaining: '66.664000000000000000',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a used value with more than MONEY_SCALE(18) decimal places', () => {
    const result = LimitViewSchema.safeParse({
      ...baseView,
      used: '33.3360000000000000001',
      remaining: '66.664000000000000000',
    });
    expect(result.success).toBe(false);
  });
});
