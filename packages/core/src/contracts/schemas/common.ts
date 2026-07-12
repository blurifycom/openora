import { z } from 'zod';

export const UuidSchema = z.uuid();
export const TimestampSchema = z.iso.datetime();

export type Uuid = z.infer<typeof UuidSchema>;

export const IdInputSchema = z.object({ id: UuidSchema });
export type IdInput = z.infer<typeof IdInputSchema>;

export const UserIdInputSchema = z.object({ userId: UuidSchema });
export type UserIdInput = z.infer<typeof UserIdInputSchema>;

export const MoneyAmountSchema = z
  .string()
  .regex(
    /^\d+(\.\d{1,2})?$/,
    'must be a non-negative decimal string with at most 2 decimal places',
  );
export type MoneyAmount = z.infer<typeof MoneyAmountSchema>;
