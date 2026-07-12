import { z } from 'zod';

export const UuidSchema = z.uuid();
export const TimestampSchema = z.iso.datetime();

export type Uuid = z.infer<typeof UuidSchema>;

export const IdInputSchema = z.object({ id: UuidSchema });
export type IdInput = z.infer<typeof IdInputSchema>;

export const UserIdInputSchema = z.object({ userId: UuidSchema });
export type UserIdInput = z.infer<typeof UserIdInputSchema>;

// Exact decimal string on the wire, matching the numeric() column on the DB side -
// money is never a JS number (float precision loss, cross-currency/crypto scale).
// Non-negative; every balance/amount/threshold in the platform is >= 0.
export const MoneyAmountSchema = z
  .string()
  .regex(/^\d+(\.\d+)?$/, 'must be a non-negative decimal string');
export type MoneyAmount = z.infer<typeof MoneyAmountSchema>;
