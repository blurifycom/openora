import * as z from 'zod';
import { MoneyAmountSchema, TimestampSchema, UuidSchema } from './common.js';
import { CurrencyCodeSchema } from './igaming-config.js';

export const MAIL_TEMPLATE_KEYS = [
  'verifyEmail',
  'resetPasswordOtp',
  'adminResetPasswordOtp',
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
  occurredAt: TimestampSchema,
} as const;

export const EmailTemplateDataSchemas = {
  verifyEmail: z.object({ otp: z.string() }),
  resetPasswordOtp: z.object({ otp: z.string(), email: z.email() }),
  adminResetPasswordOtp: z.object({ otp: z.string(), email: z.email() }),
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
  withdrawalApproved: z.object({ ...WithdrawalDetailsShape }),
  withdrawalRejected: z.object({
    ...WithdrawalDetailsShape,
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

export const MailTemplateSchema = z.discriminatedUnion('key', [
  templateVariant('verifyEmail'),
  templateVariant('resetPasswordOtp'),
  templateVariant('adminResetPasswordOtp'),
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
