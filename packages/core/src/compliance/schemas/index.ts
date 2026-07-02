import * as z from 'zod';
import { TimestampSchema, UuidSchema } from '@blurifycom/core/contracts';
import {
  KycVerificationSchema,
  KycDocumentSchema,
  SubmitKycInputSchema,
  PlayerKycViewSchema,
} from '../contract/index.js';

export {
  KycVerificationSchema,
  KycDocumentSchema,
  SubmitKycInputSchema,
  PlayerKycViewSchema,
} from '../contract/index.js';

export type KycVerification = z.infer<typeof KycVerificationSchema>;
export type KycDocumentInput = z.infer<typeof KycDocumentSchema>;
export type SubmitKycInput = z.infer<typeof SubmitKycInputSchema>;
export type PlayerKycView = z.infer<typeof PlayerKycViewSchema>;

export const LimitSchema = z.object({
  id: UuidSchema,
  userId: UuidSchema,
  type: z.enum(['deposit', 'wager', 'loss']),
  amount: z.number(),
  period: z.enum(['daily', 'weekly', 'monthly']),
  createdAt: TimestampSchema,
});

export const GeoRuleSchema = z.object({
  id: UuidSchema,
  countryCode: z.string(),
  action: z.enum(['allow', 'block']),
  createdAt: TimestampSchema,
});

export type Limit = z.infer<typeof LimitSchema>;
export type GeoRule = z.infer<typeof GeoRuleSchema>;

export const UpsertLimitInputSchema = LimitSchema.pick({ type: true, amount: true, period: true });

export const DeleteLimitInputSchema = LimitSchema.pick({ id: true });

export const AddGeoRuleInputSchema = GeoRuleSchema.pick({ countryCode: true, action: true });

export type UpsertLimitInput = z.infer<typeof UpsertLimitInputSchema>;
export type AddGeoRuleInput = z.infer<typeof AddGeoRuleInputSchema>;
