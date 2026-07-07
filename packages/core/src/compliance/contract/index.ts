import { oc } from '@orpc/contract';
import * as z from 'zod';
import {
  UuidSchema,
  KycStatusSchema,
  TimestampSchema,
  CountryCodeSchema,
  GeoRuleActionSchema,
} from '@blurifycom/core/contracts';
import { KYC_DOCUMENT_TYPES, KYC_TRIGGERED_BY } from './enums.js';
import { LimitSchema, UpsertLimitInputSchema } from './limits.js';
import { rgContract } from './rg.js';

export const KycDocumentTypeSchema = z.enum(KYC_DOCUMENT_TYPES);

export const KycTriggeredBySchema = z.enum(KYC_TRIGGERED_BY);

export const KycDocumentSchema = z.object({
  type: KycDocumentTypeSchema,
  frontUrl: z.string().min(1),
  backUrl: z.string().min(1).optional(),
});

export const KycVerificationSchema = z.object({
  id: UuidSchema,
  userId: UuidSchema,
  provider: z.string(),
  referenceId: z.string(),
  status: KycStatusSchema,
  documentTypes: z.array(KycDocumentTypeSchema),
  decisionReason: z.string().nullable(),
  triggeredBy: KycTriggeredBySchema,
  submittedAt: TimestampSchema,
  decidedAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

export const SubmitKycInputSchema = z.object({
  documents: z.array(KycDocumentSchema).min(1),
});
export type SubmitKycInput = z.infer<typeof SubmitKycInputSchema>;

export const PlayerKycViewSchema = z.object({
  current: KycVerificationSchema.nullable(),
  history: z.array(KycVerificationSchema),
});
export type PlayerKycView = z.infer<typeof PlayerKycViewSchema>;
export type KycVerification = z.infer<typeof KycVerificationSchema>;

export const GeoRuleSchema = z.object({
  id: UuidSchema,
  countryCode: CountryCodeSchema,
  action: GeoRuleActionSchema,
  createdAt: TimestampSchema,
});
export type GeoRule = z.infer<typeof GeoRuleSchema>;

const DeleteLimitInputSchema = LimitSchema.pick({ id: true });

export const AddGeoRuleInputSchema = GeoRuleSchema.pick({ countryCode: true, action: true });
export type AddGeoRuleInput = z.infer<typeof AddGeoRuleInputSchema>;

const GeoCheckOutputSchema = z.object({
  allowed: z.boolean(),
  countryCode: CountryCodeSchema.nullable(),
  reason: z.string().nullable(),
});

export const complianceContract = {
  getLimits: oc.route({ method: 'GET', path: '/compliance/limits' }).output(z.array(LimitSchema)),

  upsertLimit: oc
    .route({ method: 'PUT', path: '/compliance/limits' })
    .input(UpsertLimitInputSchema)
    .output(LimitSchema),

  deleteLimit: oc
    .route({ method: 'DELETE', path: '/compliance/limits/{id}' })
    .input(DeleteLimitInputSchema)
    .output(z.object({ success: z.literal(true) })),

  geoCheck: oc.route({ method: 'GET', path: '/compliance/geo-check' }).output(GeoCheckOutputSchema),

  addGeoRule: oc
    .route({ method: 'POST', path: '/compliance/geo-rules' })
    .input(AddGeoRuleInputSchema)
    .output(GeoRuleSchema),

  listGeoRules: oc
    .route({ method: 'GET', path: '/compliance/geo-rules' })
    .output(z.array(GeoRuleSchema)),

  getPlayerKyc: oc
    .route({ method: 'GET', path: '/compliance/players/{userId}/kyc' })
    .input(z.object({ userId: UuidSchema }))
    .output(PlayerKycViewSchema),

  submitKyc: oc
    .route({ method: 'POST', path: '/compliance/kyc' })
    .input(SubmitKycInputSchema)
    .output(KycVerificationSchema),

  kycWebhook: oc
    .route({ method: 'POST', path: '/compliance/kyc/webhook' })
    .input(z.record(z.string(), z.unknown()))
    .output(z.object({ ok: z.literal(true) })),

  ...rgContract,
};

export * from './limits.js';
export * from './rg.js';
