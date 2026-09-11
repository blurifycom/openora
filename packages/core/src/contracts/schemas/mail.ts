import * as z from 'zod';
import { MoneyAmountSchema, TimestampSchema, UuidSchema } from './common.js';
import { CurrencyCodeSchema } from './igaming-config.js';

export const MAIL_TEMPLATE_KEYS = [
  'verifyEmail',
  'twoFactorOtp',
  'resetPasswordOtp',
  'adminResetPasswordOtp',
  'existingAccountSignUp',
  'rgLimitUpdated',
  'rgCoolingOffActivated',
  'rgCoolingOffLifted',
  'rgSelfExclusionActivated',
  'rgSelfExclusionLifted',
  'depositCompleted',
  'withdrawalApproved',
  'withdrawalRejected',
  'withdrawalCompleted',
  'withdrawalFailed',
  'kycResubmissionRequested',
  'adminInvitation',
  'securityLoginAlert',
  'securityWithdrawalRequested',
  'welcome',
  'emailChangeConfirmation',
  'emailChanged',
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
  twoFactorOtp: z.object({ otp: z.string() }),
  resetPasswordOtp: z.object({ otp: z.string(), email: z.email() }),
  adminResetPasswordOtp: z.object({ otp: z.string(), email: z.email() }),
  existingAccountSignUp: z.object({ otp: z.string(), email: z.email() }),
  rgLimitUpdated: z.object({
    period: z.string(),
    type: z.string(),
    amount: MoneyAmountSchema.nullable(),
    currency: CurrencyCodeSchema.nullable(),
    minutes: z.number().int().nullable(),
  }),
  rgCoolingOffActivated: z.object({ expiresAt: TimestampSchema }),
  rgCoolingOffLifted: z.object({}),
  rgSelfExclusionActivated: z.object({
    expiresAt: TimestampSchema.nullable(),
    isPermanent: z.boolean(),
  }),
  rgSelfExclusionLifted: z.object({}),
  depositCompleted: z.object({ ...WithdrawalDetailsShape }),
  withdrawalApproved: z.object({ ...WithdrawalDetailsShape }),
  withdrawalRejected: z.object({
    ...WithdrawalDetailsShape,
    reason: z.string().nullable(),
  }),
  withdrawalCompleted: z.object({ ...WithdrawalDetailsShape }),
  withdrawalFailed: z.object({ ...WithdrawalDetailsShape }),
  kycResubmissionRequested: z.object({ reason: z.string().nullable() }),
  adminInvitation: z.object({ token: z.string(), expiresAt: TimestampSchema }),
  securityLoginAlert: z.object({ occurredAt: TimestampSchema }),
  securityWithdrawalRequested: z.object({ ...WithdrawalDetailsShape }),
  welcome: z.object({}),
  emailChangeConfirmation: z.object({ otp: z.string() }),
  emailChanged: z.object({ newEmail: z.email() }),
} as const satisfies Record<EmailTemplateKey, z.ZodType>;

export type EmailTemplateData = {
  [K in EmailTemplateKey]: z.infer<(typeof EmailTemplateDataSchemas)[K]>;
};

const templateVariant = <K extends EmailTemplateKey>(key: K) =>
  z.object({ key: z.literal(key), data: EmailTemplateDataSchemas[key] });

export const MailTemplateSchema = z.discriminatedUnion('key', [
  templateVariant('verifyEmail'),
  templateVariant('twoFactorOtp'),
  templateVariant('resetPasswordOtp'),
  templateVariant('adminResetPasswordOtp'),
  templateVariant('existingAccountSignUp'),
  templateVariant('rgLimitUpdated'),
  templateVariant('rgCoolingOffActivated'),
  templateVariant('rgCoolingOffLifted'),
  templateVariant('rgSelfExclusionActivated'),
  templateVariant('rgSelfExclusionLifted'),
  templateVariant('depositCompleted'),
  templateVariant('withdrawalApproved'),
  templateVariant('withdrawalRejected'),
  templateVariant('withdrawalCompleted'),
  templateVariant('withdrawalFailed'),
  templateVariant('kycResubmissionRequested'),
  templateVariant('adminInvitation'),
  templateVariant('securityLoginAlert'),
  templateVariant('securityWithdrawalRequested'),
  templateVariant('welcome'),
  templateVariant('emailChangeConfirmation'),
  templateVariant('emailChanged'),
]);

export type MailTemplate = {
  [K in EmailTemplateKey]: { key: K; data: EmailTemplateData[K] };
}[EmailTemplateKey];
