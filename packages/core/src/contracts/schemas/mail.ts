import * as z from 'zod';
import { CurrencyTickerSchema, MoneyAmountSchema, TimestampSchema, UuidSchema } from './common.js';
import { RgInitiatorSchema } from './compliance.js';
import { KycTierSchema } from './player.js';

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
  'depositHeld',
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
  'raceWon',
  'rankChallengeWon',
  'bonusUnlocked',
  'bonusCredited',
  'twoFactorReset',
  'withdrawalAddressAdded',
  'withdrawalsLocked',
] as const;

export type EmailTemplateKey = (typeof MAIL_TEMPLATE_KEYS)[number];

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
  depositHeld: z.object({ ...WithdrawalDetailsShape }),
  withdrawalApproved: z.object({ ...WithdrawalDetailsShape }),
  withdrawalRejected: z.object({
    ...WithdrawalDetailsShape,
    reason: z.string().nullable(),
  }),
  withdrawalCompleted: z.object({ ...WithdrawalDetailsShape }),
  withdrawalFailed: z.object({ ...WithdrawalDetailsShape }),
  kycResubmissionRequested: z.object({
    reason: z.string().nullable(),
    tier: KycTierSchema.default('basic'),
  }),
  adminInvitation: z.object({ token: z.string(), expiresAt: TimestampSchema }),
  securityLoginAlert: z.object({ occurredAt: TimestampSchema }),
  securityWithdrawalRequested: z.object({ ...WithdrawalDetailsShape }),
  welcome: z.object({ promotionsEligible: z.boolean().optional() }),
  emailChangeConfirmation: z.object({
    otp: z.string(),
    oldEmail: z.string(),
    newEmail: z.email(),
  }),
  emailChanged: z.object({
    newEmail: z.email(),
    occurredAt: TimestampSchema,
    isNewAddress: z.boolean(),
  }),
  securityAntiPhishingCodeChanged: z.object({ previousAntiPhishingCode: z.string().nullable() }),
  twoFactorReset: z.object({ occurredAt: TimestampSchema }),
  withdrawalAddressAdded: z.object({
    address: z.string(),
    network: z.string(),
    occurredAt: TimestampSchema,
  }),
  withdrawalsLocked: z.object({ occurredAt: TimestampSchema }),
  raceWon: z.object({
    raceName: z.string(),
    position: z.number().int().positive(),
    amount: MoneyAmountSchema,
    currency: CurrencyTickerSchema,
  }),
  rankChallengeWon: z.object({
    tierName: z.string(),
    cashAmount: MoneyAmountSchema.nullable(),
    physicalItem: z.string().nullable(),
    currency: CurrencyTickerSchema,
  }),
  bonusUnlocked: z.object({
    convertedAmount: MoneyAmountSchema,
    currency: CurrencyTickerSchema,
  }),
  bonusCredited: z.object({
    grantedAmount: MoneyAmountSchema,
    wageringRequired: MoneyAmountSchema,
    currency: CurrencyTickerSchema,
  }),
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
  templateVariant('depositHeld'),
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
  templateVariant('raceWon'),
  templateVariant('rankChallengeWon'),
  templateVariant('bonusUnlocked'),
  templateVariant('bonusCredited'),
  templateVariant('twoFactorReset'),
  templateVariant('withdrawalAddressAdded'),
  templateVariant('withdrawalsLocked'),
]);

export type MailTemplate = {
  [K in EmailTemplateKey]: { key: K; data: EmailTemplateData[K] };
}[EmailTemplateKey];
