import { describe, it, expect } from 'vitest';
import * as z from 'zod';
import { BetsFindInputSchema, resolveBetsFindRange } from '../contract/index.js';

describe('sportsbook.bets_find input', () => {
  const parse = (input: unknown) => z.safeParse(BetsFindInputSchema, input);

  it('defaults to the 20 bets placed last over the 30 days ending today', () => {
    expect(parse({})).toEqual({
      success: true,
      data: { sortBy: 'placedAt', sortDir: 'desc', limit: 20 },
    });
    expect(resolveBetsFindRange({}, new Date('2026-03-10T15:00:00.000Z'))).toEqual({
      dateFrom: '2026-02-09',
      dateTo: '2026-03-10',
    });
  });

  it('takes at most 92 days, named by the fields the caller sent', () => {
    expect(parse({ placedFrom: '2026-01-01', placedTo: '2026-04-02' }).success).toBe(true);
    expect(parse({ placedFrom: '2026-01-01', placedTo: '2026-04-03' }).error?.issues).toEqual([
      expect.objectContaining({ path: ['placedFrom'] }),
    ]);
    expect(parse({ placedFrom: '2026-01-02', placedTo: '2026-01-01' }).success).toBe(false);
  });

  it('takes only the statuses, results and sorts it knows, and a decimal stake', () => {
    expect(
      parse({ status: ['settled'], result: ['won', 'cashed_out'], minStake: '10.5' }).success,
    ).toBe(true);
    expect(parse({ status: ['open'] }).success).toBe(false);
    expect(parse({ result: ['push'] }).success).toBe(false);
    expect(parse({ sortBy: 'odds' }).success).toBe(false);
    expect(parse({ minStake: 10 }).success).toBe(false);
    expect(parse({ limit: 51 }).success).toBe(false);
  });
});
