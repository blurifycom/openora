import * as z from 'zod';
import { MoneyAmountSchema, TimestampSchema, UuidSchema } from './common.js';
import { CurrencyCodeSchema } from './igaming-config.js';

/**
 * The wire contract for a single outbound email, shared by the mail module
 * (`MAIL_DISPATCH`), the notifications module (`CreateNotificationInput.email`),
 * and the identity/iam callers. A template is named by `key` and always carries
 * the exact `data` shape that key renders - a tagged union, so `key` narrows
 * `data` to one payload (a bare generic over the key would not).
 *
 * Datetimes travel as ISO-8601 strings, never `Date`: every dispatch crosses the
 * `mail-send` job queue, and a `Date` does not survive JSON serialization there.
 * The renderer formats them against the recipient locale (see EMAIL_TEMPLATE_RENDERER).
 *
 * Openora core ships an English-only plain-text fallback for every key
 * (DEFAULT_EMAIL_TEMPLATES); an operator overlay replaces the renderer to add
 * languages and HTML design.
 */
export const MAIL_TEMPLATE_KEYS = [
  'verifyEmail',
  'resetPasswordOtp',
  'existingAccountSignUp',
  'rgLimitUpdated',
  'rgCoolingOffActivated',
  'rgCoolingOffLifted',
  'rgSelfExclusionActivated',
  'rgSelfExclusionLifted',
  'withdrawalApproved',
  'withdrawalRejected',
  'kycResubmissionRequested',
  'adminInvitation',
] as const;

export type EmailTemplateKey = (typeof MAIL_TEMPLATE_KEYS)[number];

const WithdrawalDetailsShape = {
  amount: MoneyAmountSchema,
  currency: CurrencyCodeSchema,
  transactionId: UuidSchema,
  // The moment the withdrawal decision was taken (`envelope.occurredAt`), NOT the
  // moment the mail worker ran - a retry an hour later must not rewrite the date.
  occurredAt: TimestampSchema,
} as const;

/**
 * One Zod object per template key, holding exactly the fields that key renders.
 * `EmailTemplateData` is inferred from this map, so the type and the runtime
 * validator can never drift.
 */
export const EmailTemplateDataSchemas = {
  verifyEmail: z.object({ otp: z.string() }),
  resetPasswordOtp: z.object({ otp: z.string(), email: z.email() }),
  existingAccountSignUp: z.object({ otp: z.string(), email: z.email() }),
  rgLimitUpdated: z.object({
    period: z.string(),
    type: z.string(),
    description: z.string(),
  }),
  rgCoolingOffActivated: z.object({ expiresAt: TimestampSchema }),
  rgCoolingOffLifted: z.object({}),
  rgSelfExclusionActivated: z.object({
    expiresAt: TimestampSchema.nullable(),
    isPermanent: z.boolean(),
  }),
  rgSelfExclusionLifted: z.object({}),
  withdrawalApproved: z.object({ ...WithdrawalDetailsShape, status: z.literal('approved') }),
  withdrawalRejected: z.object({
    ...WithdrawalDetailsShape,
    status: z.literal('rejected'),
    reason: z.string().nullable(),
  }),
  kycResubmissionRequested: z.object({ reason: z.string().nullable() }),
  adminInvitation: z.object({ token: z.string(), expiresAt: TimestampSchema }),
} as const satisfies Record<EmailTemplateKey, z.ZodType>;

export type EmailTemplateData = {
  [K in EmailTemplateKey]: z.infer<(typeof EmailTemplateDataSchemas)[K]>;
};

const templateVariant = <K extends EmailTemplateKey>(key: K) =>
  z.object({ key: z.literal(key), data: EmailTemplateDataSchemas[key] });

/**
 * `{ key, data }` tagged union. `MailTemplateSchema.parse` narrows `data` to the
 * payload the key names.
 */
export const MailTemplateSchema = z.discriminatedUnion('key', [
  templateVariant('verifyEmail'),
  templateVariant('resetPasswordOtp'),
  templateVariant('existingAccountSignUp'),
  templateVariant('rgLimitUpdated'),
  templateVariant('rgCoolingOffActivated'),
  templateVariant('rgCoolingOffLifted'),
  templateVariant('rgSelfExclusionActivated'),
  templateVariant('rgSelfExclusionLifted'),
  templateVariant('withdrawalApproved'),
  templateVariant('withdrawalRejected'),
  templateVariant('kycResubmissionRequested'),
  templateVariant('adminInvitation'),
]);

export type MailTemplate = {
  [K in EmailTemplateKey]: { key: K; data: EmailTemplateData[K] };
}[EmailTemplateKey];
