import { z } from 'zod';

export const UuidSchema = z.uuid();
export const TimestampSchema = z.iso.datetime();
export const JsonSchemaDocumentSchema = z.record(z.string(), z.json());
export type JsonSchemaDocument = z.infer<typeof JsonSchemaDocumentSchema>;

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

export const MONEY_SCALE = 18;
export const MONEY_PRECISION = 38;
const MONEY_INTEGER_DIGITS = MONEY_PRECISION - MONEY_SCALE;

export const MoneyAmountSchema = z
  .string()
  .regex(
    new RegExp(`^0*\\d{1,${MONEY_INTEGER_DIGITS}}(\\.\\d{1,${MONEY_SCALE}})?$`),
    `must be a non-negative decimal string below 10^${MONEY_INTEGER_DIGITS} with at most ${MONEY_SCALE} decimal places`,
  );
export type MoneyAmount = z.infer<typeof MoneyAmountSchema>;

export function formatMoneyAmount(amount: string): string {
  const match = /^(-)?(\d+)(?:\.(\d+))?$/.exec(amount);
  if (!match) {
    return amount;
  }
  const [, sign, integerPart, fractionPart] = match;
  const groupedInteger = integerPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const trimmedFraction = fractionPart ? fractionPart.replace(/0+$/, '') : '';
  const magnitude = trimmedFraction ? `${groupedInteger}.${trimmedFraction}` : groupedInteger;
  return sign ? `${sign}${magnitude}` : magnitude;
}

export const AUTH_GUARD_REASONS = [
  'missing_request_context',
  'authentication_required',
  'admin_required',
  'permission_denied',
  'two_factor_required',
  'session_fingerprint_mismatch',
  'two_factor_setup_required',
  'session_idle_timeout',
] as const;
export const AuthGuardReasonSchema = z.enum(AUTH_GUARD_REASONS);
export type AuthGuardReason = z.infer<typeof AuthGuardReasonSchema>;

export const SignedMoneyAmountSchema = z
  .string()
  .regex(
    new RegExp(`^-?\\d{1,${MONEY_INTEGER_DIGITS}}(\\.\\d{1,${MONEY_SCALE}})?$`),
    `must be a decimal string (optionally negative) with at most ${MONEY_INTEGER_DIGITS} integer and ${MONEY_SCALE} decimal places`,
  );
export type SignedMoneyAmount = z.infer<typeof SignedMoneyAmountSchema>;

export const CurrencyTickerSchema = z
  .string()
  .regex(/^[A-Za-z]{3,10}$/, 'currency code, e.g. USD or USDT');

export const CurrencyTickerInputSchema = CurrencyTickerSchema.transform((c) => c.toUpperCase());

export const TimezoneSchema = z.string();
export type Timezone = z.infer<typeof TimezoneSchema>;

export function resolveTimezone(value: string): string | null {
  let canonical: string;
  try {
    canonical = new Intl.DateTimeFormat(undefined, { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
  return /^[+-]/.test(canonical) ? null : canonical;
}
