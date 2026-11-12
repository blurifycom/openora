import { describe, it, expect } from 'vitest';
import * as z from 'zod';
import { DepositCompareInputSchema, WithdrawalsQueueInputSchema } from '../contract/index.js';

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
