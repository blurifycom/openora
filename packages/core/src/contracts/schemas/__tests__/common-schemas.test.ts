import { describe, it, expect } from 'vitest';
import { MoneyAmountSchema } from '../common.js';

describe('MoneyAmountSchema', () => {
  it('round-trips a 1-wei ETH amount (18-decimal precision)', () => {
    expect(MoneyAmountSchema.parse('0.000000000000000001')).toBe('0.000000000000000001');
    expect(MoneyAmountSchema.parse('21000000.123456789012345678')).toBe(
      '21000000.123456789012345678',
    );
  });

  it('round-trips an 8-decimal-place crypto amount (BTC-level precision)', () => {
    expect(MoneyAmountSchema.parse('0.00000001')).toBe('0.00000001');
  });

  it('still accepts a plain 2-decimal fiat amount', () => {
    expect(MoneyAmountSchema.parse('19.99')).toBe('19.99');
    expect(MoneyAmountSchema.parse('0')).toBe('0');
  });

  it('rejects more than 18 decimal places and a negative amount', () => {
    expect(MoneyAmountSchema.safeParse('0.0000000000000000001').success).toBe(false);
    expect(MoneyAmountSchema.safeParse('-1').success).toBe(false);
  });
});
