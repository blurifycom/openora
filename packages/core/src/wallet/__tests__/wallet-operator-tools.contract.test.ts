import { describe, it, expect } from 'vitest';
import * as z from 'zod';
import {
  DepositCompareInputSchema,
  TransactionsFindInputSchema,
  WithdrawalsQueueInputSchema,
  resolveTransactionsFindRange,
} from '../contract/index.js';

const WINDOW_A = { from: '2026-01-01', to: '2026-03-31' };
const WINDOW_B = { from: '2026-04-01', to: '2026-07-01' };

describe('withdrawals.queue input', () => {
  const parse = (input: unknown) => z.safeParse(WithdrawalsQueueInputSchema, input);

  it('defaults to the 10 oldest of both queued statuses', () => {
    expect(parse({})).toEqual({ success: true, data: { limit: 10 } });
  });

  it('takes a limit from 1 to 20 and only a queued status', () => {
    expect(parse({ limit: '20', status: 'on_hold' }).success).toBe(true);
    expect(parse({ limit: 0 }).success).toBe(false);
    expect(parse({ limit: 21 }).success).toBe(false);
    expect(parse({ status: 'completed' }).success).toBe(false);
  });
});

describe('players.deposit_compare input', () => {
  const parse = (input: unknown) => z.safeParse(DepositCompareInputSchema, input);

  it('defaults to the 20 largest drops', () => {
    expect(parse({ tag: 'vip', windowA: WINDOW_A, windowB: WINDOW_B })).toEqual({
      success: true,
      data: { tag: 'vip', windowA: WINDOW_A, windowB: WINDOW_B, order: 'largest_drop', limit: 20 },
    });
  });

  it('accepts a window of exactly 92 days and refuses one day more, naming the window', () => {
    const tooLong = { from: '2026-04-01', to: '2026-07-02' };

    expect(parse({ tag: 'vip', windowA: WINDOW_A, windowB: tooLong }).error?.issues).toEqual([
      expect.objectContaining({ path: ['windowB', 'from'] }),
    ]);
  });

  it('refuses a window that ends before it starts, a tag that is not a tag key and a limit above 50', () => {
    const inverted = { from: '2026-03-31', to: '2026-01-01' };

    expect(parse({ tag: 'vip', windowA: inverted, windowB: WINDOW_B }).error?.issues).toEqual([
      expect.objectContaining({ path: ['windowA', 'from'] }),
    ]);
    expect(parse({ tag: 'whales', windowA: WINDOW_A, windowB: WINDOW_B }).success).toBe(false);
    expect(parse({ tag: 'vip', windowA: WINDOW_A, windowB: WINDOW_B, limit: 51 }).success).toBe(
      false,
    );
  });
});

describe('transactions.find input', () => {
  const parse = (input: unknown) => z.safeParse(TransactionsFindInputSchema, input);

  it('defaults to the 20 newest over the 30 days ending today', () => {
    expect(parse({})).toEqual({
      success: true,
      data: { sortBy: 'createdAt', sortDir: 'desc', limit: 20 },
    });
    expect(resolveTransactionsFindRange({ to: '2026-03-10' })).toEqual({
      dateFrom: '2026-02-09',
      dateTo: '2026-03-10',
    });
  });

  it('takes at most 92 days, named by the fields the caller sent', () => {
    expect(parse({ from: '2026-01-01', to: '2026-04-02' }).success).toBe(true);
    expect(parse({ from: '2026-01-01', to: '2026-04-03' }).error?.issues).toEqual([
      expect.objectContaining({ path: ['from'] }),
    ]);
    expect(parse({ from: '2026-01-02', to: '2026-01-01' }).success).toBe(false);
  });

  it('takes only the types, statuses and sorts it knows, and a decimal amount', () => {
    expect(
      parse({ type: ['deposit', 'withdrawal'], status: ['on_hold'], minAmount: '1000' }).success,
    ).toBe(true);
    expect(parse({ type: ['refund'] }).success).toBe(false);
    expect(parse({ status: ['done'] }).success).toBe(false);
    expect(parse({ sortBy: 'fee' }).success).toBe(false);
    expect(parse({ minAmount: '1,000' }).success).toBe(false);
    expect(parse({ limit: 51 }).success).toBe(false);
  });
});
