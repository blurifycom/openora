import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { DepositInputSchema, WalletBalanceSchema } from '../contract/index.js';

describe('wallet currency codes', () => {
  it('uppercases the currency on the way in', () => {
    const parsed = DepositInputSchema.parse({
      amount: '10',
      currency: 'usdt',
      idempotencyKey: randomUUID(),
    });
    expect(parsed.currency).toBe('USDT');
  });

  it('rejects a non-alphabetic or out-of-range code', () => {
    expect(() => DepositInputSchema.parse({ amount: '10', currency: 'US$' })).toThrow();
    expect(() => DepositInputSchema.parse({ amount: '10', currency: 'US' })).toThrow();
    expect(() => WalletBalanceSchema.parse({ balance: '0', currency: '' })).toThrow();
  });
});
