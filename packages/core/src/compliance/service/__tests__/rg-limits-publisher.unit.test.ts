import { describe, expect, it } from 'vitest';
import { projectedLimit } from '../rg-limits-publisher.service.js';

type LimitRow = Parameters<typeof projectedLimit>[0];

const valid: LimitRow = {
  userId: '11111111-1111-4111-8111-111111111111',
  limitId: '22222222-2222-4222-8222-222222222222',
  type: 'deposit',
  period: 'daily',
  amount: '100.5',
  currency: 'USDT',
  changedAt: new Date('2026-03-01T10:00:00.000Z'),
};

describe('projectedLimit', () => {
  it('keeps a row with no currency, to be resolved from the player', () => {
    expect(projectedLimit({ ...valid, currency: null }).currency).toBeNull();
    expect(projectedLimit({ ...valid, currency: null }).amount).toBe('100.5');
  });

  it('projects a valid row unchanged with an ISO changedAt', () => {
    expect(projectedLimit(valid)).toEqual({
      limitId: valid.limitId,
      type: 'deposit',
      period: 'daily',
      amount: '100.5',
      currency: 'USDT',
      changedAt: '2026-03-01T10:00:00.000Z',
    });
  });

  it.each([
    ['an empty currency', { currency: '' }],
    ['a malformed amount', { amount: 'abc' }],
    ['a negative amount', { amount: '-5' }],
    ['an amount with too many decimals', { amount: '1.1234567890123456789' }],
  ] as const)('projects %s to amount 0 with no currency', (_name, over) => {
    const projected = projectedLimit({ ...valid, ...over });
    expect(projected.amount).toBe('0');
    expect(projected.currency).toBeNull();
    expect(projected.limitId).toBe(valid.limitId);
  });
});
