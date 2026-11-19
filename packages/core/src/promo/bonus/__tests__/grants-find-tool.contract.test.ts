import { describe, it, expect } from 'vitest';
import * as z from 'zod';
import { GrantsFindInputSchema } from '../contract/index.js';

describe('bonus.grants_find input', () => {
  const parse = (input: unknown) => z.safeParse(GrantsFindInputSchema, input);

  it('defaults to the 20 newest grants and takes a limit from 1 to 50', () => {
    expect(parse({})).toEqual({ success: true, data: { limit: 20 } });
    expect(parse({ limit: '50' }).success).toBe(true);
    expect(parse({ limit: 51 }).success).toBe(false);
  });

  it('looks 1 to 90 days ahead for expiring grants', () => {
    expect(parse({ expiringWithinDays: '7' }).success).toBe(true);
    expect(parse({ expiringWithinDays: 0 }).success).toBe(false);
    expect(parse({ expiringWithinDays: 91 }).success).toBe(false);
  });

  it('takes only the statuses and sources it knows, and ordered activation days', () => {
    expect(parse({ status: ['active', 'forfeited'], source: ['deposit'] }).success).toBe(true);
    expect(parse({ status: ['live'] }).success).toBe(false);
    expect(parse({ source: ['loyalty'] }).success).toBe(false);
    expect(parse({ activatedFrom: '2026-01-01' }).success).toBe(true);
    expect(parse({ activatedFrom: '2026-01-02', activatedTo: '2026-01-01' }).error?.issues).toEqual(
      [expect.objectContaining({ path: ['activatedFrom'] })],
    );
  });
});
