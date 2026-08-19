import { z } from 'zod';

export const UuidSchema = z.uuid();
export const TimestampSchema = z.iso.datetime();

export type Uuid = z.infer<typeof UuidSchema>;

export const IdInputSchema = z.object({ id: UuidSchema });
export type IdInput = z.infer<typeof IdInputSchema>;

export const UserIdInputSchema = z.object({ userId: UuidSchema });
export type UserIdInput = z.infer<typeof UserIdInputSchema>;

export const ClientMetaSchema = z.object({
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
});
export type ClientMeta = z.infer<typeof ClientMetaSchema>;

// The platform is crypto-first: ETH and most ERC-20s carry 18 decimals, so a balance has
// to round-trip 0.000000000000000001. Every money column builds its numeric(p,s) from
// these two constants and both regexes below derive from MONEY_SCALE, so the DB column
// and the contract can never drift into truncating each other.
export const MONEY_SCALE = 18;
export const MONEY_PRECISION = 38;

export const MoneyAmountSchema = z
  .string()
  .regex(
    new RegExp(`^\\d+(\\.\\d{1,${MONEY_SCALE}})?$`),
    `must be a non-negative decimal string with at most ${MONEY_SCALE} decimal places`,
  );
export type MoneyAmount = z.infer<typeof MoneyAmountSchema>;

export const AUTH_GUARD_REASONS = [
  'missing_request_context',
  'authentication_required',
  'admin_required',
  'permission_denied',
] as const;
export const AuthGuardReasonSchema = z.enum(AUTH_GUARD_REASONS);
export type AuthGuardReason = z.infer<typeof AuthGuardReasonSchema>;

// A money-shaped value that MAY be negative - eg GGR (bets - wins) over a period, which
// legitimately goes negative when players are paid out more than they wagered. Never use
// for a balance/threshold/ledger amount, which stay non-negative (MoneyAmountSchema).
export const SignedMoneyAmountSchema = z
  .string()
  .regex(
    new RegExp(`^-?\\d+(\\.\\d{1,${MONEY_SCALE}})?$`),
    `must be a decimal string (optionally negative) with at most ${MONEY_SCALE} decimal places`,
  );
export type SignedMoneyAmount = z.infer<typeof SignedMoneyAmountSchema>;
