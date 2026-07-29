import { eventIterator, oc } from '@orpc/contract';
import * as z from 'zod';
import {
  UuidSchema,
  KycStatusSchema,
  KycCheckResultSchema,
  TimestampSchema,
  CountryCodeSchema,
  GeoRuleActionSchema,
} from '@openora/core/contracts';
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

export const KycRiskSignalsSchema = z.object({
  vpnOrTorDetected: z.boolean(),
  dataCenterIpDetected: z.boolean(),
  duplicateDeviceDetected: z.boolean(),
  highRiskCountryDetected: z.boolean(),
  deviceFingerprints: z.array(z.string()),
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
  riskSignals: KycRiskSignalsSchema.nullable(),
  checks: z.array(KycCheckResultSchema).nullable(),
  submittedAt: TimestampSchema,
  decidedAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

export const SubmitKycInputSchema = z.object({
  documents: z.array(KycDocumentSchema),
});
export type SubmitKycInput = z.infer<typeof SubmitKycInputSchema>;

export const SubmitKycOutputSchema = KycVerificationSchema.extend({
  verificationUrl: z.string().optional(),
});
export type SubmitKycOutput = z.infer<typeof SubmitKycOutputSchema>;

export const PlayerKycViewSchema = z.object({
  current: KycVerificationSchema.nullable(),
  history: z.array(KycVerificationSchema),
});
export type PlayerKycView = z.infer<typeof PlayerKycViewSchema>;
export type KycVerification = z.infer<typeof KycVerificationSchema>;

export const KycStatusUpdateSchema = z.object({
  status: KycStatusSchema,
});
export type KycStatusUpdate = z.infer<typeof KycStatusUpdateSchema>;

const NonEmptyReasonSchema = z.string().trim().min(1);

export const RequestKycResubmissionInputSchema = z.object({
  userId: UuidSchema,
  reason: NonEmptyReasonSchema,
});
export type RequestKycResubmissionInput = z.infer<typeof RequestKycResubmissionInputSchema>;

export const KycOverrideStatusSchema = KycStatusSchema.exclude(['verified', 'manually_overridden']);
export type KycOverrideStatus = z.infer<typeof KycOverrideStatusSchema>;

export const OverrideKycStatusInputSchema = z.object({
  userId: UuidSchema,
  status: KycOverrideStatusSchema,
  reason: NonEmptyReasonSchema,
});
export type OverrideKycStatusInput = z.infer<typeof OverrideKycStatusInputSchema>;

const MAX_BULK_KYC_APPROVE_USERS = 100;

export const BulkApproveKycInputSchema = z.object({
  userIds: z
    .array(UuidSchema)
    .min(1)
    .max(MAX_BULK_KYC_APPROVE_USERS)
    .refine((ids) => new Set(ids).size === ids.length, { message: 'userIds must be unique' }),
  reason: NonEmptyReasonSchema,
});
export type BulkApproveKycInput = z.infer<typeof BulkApproveKycInputSchema>;

export const BulkApproveKycResultSchema = z.object({
  userId: UuidSchema,
  success: z.boolean(),
  error: z.string().nullable(),
});
export type BulkApproveKycResult = z.infer<typeof BulkApproveKycResultSchema>;

export const BulkApproveKycOutputSchema = z.object({
  results: z.array(BulkApproveKycResultSchema),
});
export type BulkApproveKycOutput = z.infer<typeof BulkApproveKycOutputSchema>;

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
    .output(SubmitKycOutputSchema),

  streamKycStatus: oc
    .route({ method: 'GET', path: '/compliance/kyc/stream' })
    .output(eventIterator(KycStatusUpdateSchema)),

  kycWebhook: oc
    .route({ method: 'POST', path: '/compliance/kyc/webhook' })
    .input(z.record(z.string(), z.unknown()))
    .output(z.object({ ok: z.literal(true) })),

  requestKycResubmission: oc
    .route({ method: 'POST', path: '/compliance/players/{userId}/kyc/resubmit' })
    .input(RequestKycResubmissionInputSchema)
    .output(KycVerificationSchema),

  overrideKycStatus: oc
    .route({ method: 'POST', path: '/compliance/players/{userId}/kyc/override' })
    .input(OverrideKycStatusInputSchema)
    .output(KycVerificationSchema),

  bulkApproveKyc: oc
    .route({ method: 'POST', path: '/compliance/kyc/bulk-approve' })
    .input(BulkApproveKycInputSchema)
    .output(BulkApproveKycOutputSchema),

  ...rgContract,
};

export * from './limits.js';
export * from './rg.js';
