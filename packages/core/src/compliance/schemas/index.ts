import * as z from 'zod';
import {
  KycVerificationSchema,
  KycDocumentSchema,
  SubmitKycInputSchema,
  PlayerKycViewSchema,
  GeoRuleSchema,
  LimitSchema,
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

export { GeoRuleSchema, LimitSchema };
export type Limit = z.infer<typeof LimitSchema>;
export type GeoRule = z.infer<typeof GeoRuleSchema>;

export const UpsertLimitInputSchema = LimitSchema.pick({ type: true, amount: true, period: true });
export const DeleteLimitInputSchema = LimitSchema.pick({ id: true });
export const AddGeoRuleInputSchema = GeoRuleSchema.pick({ countryCode: true, action: true });

export type UpsertLimitInput = z.infer<typeof UpsertLimitInputSchema>;
export type AddGeoRuleInput = z.infer<typeof AddGeoRuleInputSchema>;
