import { describe, it, expect } from 'vitest';
import * as z from 'zod';
import {
  ReasonInputSchema,
  SetSportsbookRestrictionInputSchema,
  WriteOffSportsbookDebtInputSchema,
} from '../contract/index.js';

const ID = '7f9c3b8e-2d4a-4c1e-9b6f-0a5d8e3c2b1a';
const KEY = '1c2b3a4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';

const sites = [
  [
    'a sportsbook restriction',
    (reason: string) => z.safeParse(SetSportsbookRestrictionInputSchema, { userId: ID, reason }),
  ],
  ['a reason-only action', (reason: string) => z.safeParse(ReasonInputSchema, { reason })],
  [
    'a debt write-off',
    (reason: string) =>
      z.safeParse(WriteOffSportsbookDebtInputSchema, { id: ID, reason, idempotencyKey: KEY }),
  ],
] as const;

describe.each(sites)('the reason on %s', (_site, parse) => {
  it('caps the reason at 500 characters after trimming and refuses an all-space one', () => {
    expect(parse(`  ${'r'.repeat(500)}  `)).toMatchObject({
      success: true,
      data: { reason: 'r'.repeat(500) },
    });
    expect(parse('r'.repeat(501)).success).toBe(false);
    expect(parse('   ').success).toBe(false);
    expect(parse('').success).toBe(false);
  });
});
