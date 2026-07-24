import { z } from 'zod';

export const UuidSchema = z.uuid();
export const TimestampSchema = z.iso.datetime();

export type Uuid = z.infer<typeof UuidSchema>;

export const IdInputSchema = z.object({ id: UuidSchema });
export type IdInput = z.infer<typeof IdInputSchema>;

export const UserIdInputSchema = z.object({ userId: UuidSchema });
export type UserIdInput = z.infer<typeof UserIdInputSchema>;

/**
 * Caller transport metadata attributed to an audited action. `null` means the
 * request carried no usable value - the sole source is `extractClientMeta`
 * (`@openora/core/server`), never a hand-built literal, so a future
 * proxy-trust/IP-spoofing fix lands in one place for every call site.
 */
export const ClientMetaSchema = z.object({
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
});
export type ClientMeta = z.infer<typeof ClientMetaSchema>;

export const MoneyAmountSchema = z
  .string()
  .regex(
    /^\d+(\.\d{1,8})?$/,
    'must be a non-negative decimal string with at most 8 decimal places',
  );
export type MoneyAmount = z.infer<typeof MoneyAmountSchema>;
