import * as z from 'zod';
import { CurrencyTickerSchema, MoneyAmountSchema, TimestampSchema, UuidSchema } from './common.js';
import { RgInitiatorSchema } from './compliance.js';

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
  'securityAntiPhishingCodeChanged',
] as const;

export type EmailTemplateKey = (typeof MAIL_TEMPLATE_KEYS)[number];

// Ticker, not the ISO-4217 code: a wallet holds crypto as well as fiat, and a four-letter
// ticker (USDT, USDC, DOGE) failed the three-character rule - the mail job then failed its
// retries in the queue and the player was never told their money moved. This is the string
// the mail prints; the money path validates the amount and the wallet's currency itself.
const WithdrawalDetailsShape = {
  amount: MoneyAmountSchema,
  currency: CurrencyTickerSchema,
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
    currency: CurrencyTickerSchema.nullable(),
    minutes: z.number().int().nullable(),
    initiatedBy: RgInitiatorSchema,
  }),
  rgCoolingOffActivated: z.object({ expiresAt: TimestampSchema, initiatedBy: RgInitiatorSchema }),
  rgCoolingOffLifted: z.object({ initiatedBy: RgInitiatorSchema }),
  rgSelfExclusionActivated: z.object({
    expiresAt: TimestampSchema.nullable(),
    isPermanent: z.boolean(),
    initiatedBy: RgInitiatorSchema,
  }),
  rgSelfExclusionLifted: z.object({ initiatedBy: RgInitiatorSchema }),
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
  emailChangeConfirmation: z.object({
    otp: z.string(),
    // Masked, never the full address: this mail goes to the new inbox before it has
    // proven anything, so the current owner's real address must not leak to whoever
    // typed it in as the target.
    oldEmail: z.string(),
    newEmail: z.email(),
  }),
  emailChanged: z.object({
    newEmail: z.email(),
    occurredAt: TimestampSchema,
    isNewAddress: z.boolean(),
  }),
  securityAntiPhishingCodeChanged: z.object({ previousAntiPhishingCode: z.string().nullable() }),
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
  templateVariant('securityAntiPhishingCodeChanged'),
]);

export type MailTemplate = {
  [K in EmailTemplateKey]: { key: K; data: EmailTemplateData[K] };
}[EmailTemplateKey];
