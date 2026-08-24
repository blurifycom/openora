import { describe, it, expect } from 'vitest';
import {
  DepositInputSchema,
  WalletBalanceSchema,
  WithdrawInputSchema,
  CreateWithdrawalAddressInputSchema,
} from '../contract/index.js';

describe('wallet currency codes', () => {
  it('uppercases the currency on the way in', () => {
    const parsed = DepositInputSchema.parse({ amount: '10', currency: 'usdt' });
    expect(parsed.currency).toBe('USDT');
  });

  it('rejects a non-alphabetic or out-of-range code', () => {
    expect(() => DepositInputSchema.parse({ amount: '10', currency: 'US$' })).toThrow();
    expect(() => DepositInputSchema.parse({ amount: '10', currency: 'US' })).toThrow();
    expect(() => WalletBalanceSchema.parse({ balance: '0', currency: '' })).toThrow();
  });
});

describe('withdrawal destination address', () => {
  const ADDRESS = '0xAbCdEf1111111111111111111111111111111111';

  // The whitelist lookup matches the saved row by exact string equality, so both paths
  // have to land on the same value for a pasted address with stray whitespace.
  it('trims on the withdraw path exactly like the address book does', () => {
    const saved = CreateWithdrawalAddressInputSchema.parse({
      label: 'Ledger',
      currency: 'usdt',
      network: 'erc20',
      address: `  ${ADDRESS}  `,
    });
    const payout = WithdrawInputSchema.parse({
      amount: '10',
      currency: 'usdt',
      idempotencyKey: '9a2f7c11-0000-4000-8000-00000000a001',
      destinationAddress: ` ${ADDRESS}\n`,
    });
    expect(payout.destinationAddress).toBe(saved.address);
  });

  it('keeps the case, since base58 rails are case-sensitive', () => {
    const payout = WithdrawInputSchema.parse({
      amount: '10',
      currency: 'usdt',
      idempotencyKey: '9a2f7c11-0000-4000-8000-00000000a001',
      destinationAddress: ADDRESS,
    });
    expect(payout.destinationAddress).toBe(ADDRESS);
  });
});
