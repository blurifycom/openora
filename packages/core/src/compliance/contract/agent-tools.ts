import * as z from 'zod';
import {
  KycStatusSchema,
  NonEmptyReasonSchema,
  TimestampSchema,
  UuidSchema,
  defineActionType,
  defineMcpTool,
} from '@openora/core/contracts';
import { KycDocumentTypeSchema, KycTriggeredBySchema } from './enums.js';

export const KycStandingVerificationSchema = z.object({
  status: KycStatusSchema,
  provider: z.string(),
  documentTypes: z.array(KycDocumentTypeSchema),
  triggeredBy: KycTriggeredBySchema,
  decidedAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
});
export type KycStandingVerification = z.infer<typeof KycStandingVerificationSchema>;

export const KycStandingInputSchema = z.object({ playerId: UuidSchema });

export const KycStandingOutputSchema = z.object({
  playerId: UuidSchema,
  kycStatus: KycStatusSchema,
  basic: KycStandingVerificationSchema.nullable(),
  advanced: KycStandingVerificationSchema.nullable(),
  basicDecisionReason: z.string().nullable(),
  advancedDecisionReason: z.string().nullable(),
});
export type KycStanding = z.infer<typeof KycStandingOutputSchema>;

export const kycStatusTool = defineMcpTool({
  id: 'kyc.status',
  title: 'KYC status',
  description:
    "A player's KYC standing: kycStatus is their basic-tier status; basic and advanced are " +
    'the current verification of each tier (advanced is enhanced KYC) with its status, ' +
    'provider, document types, what triggered it, and when it was created and decided, or ' +
    "null when the player has none on that tier. The vendor's free-text decision reason for " +
    'each tier is returned separately.',
  class: 'read',
  schemaVersion: 1,
  iam: { resource: 'compliance', action: 'view' },
  inputSchema: KycStandingInputSchema,
  outputSchema: KycStandingOutputSchema,
  redact: {
    allow: [
      'playerId',
      'kycStatus',
      'basic',
      'advanced',
      'basicDecisionReason',
      'advancedDecisionReason',
    ],
    personal: ['basicDecisionReason', 'advancedDecisionReason'],
  },
  errors: ['player_not_found'],
});

export const RequestEnhancedKycPayloadSchema = z.object({
  playerId: UuidSchema,
  reason: NonEmptyReasonSchema.max(500),
});
export type RequestEnhancedKycPayload = z.infer<typeof RequestEnhancedKycPayloadSchema>;

export const requestEnhancedKycAction = defineActionType({
  id: 'request_enhanced_kyc',
  title: 'Request enhanced KYC',
  description:
    'Asks a player to complete advanced-tier (enhanced) KYC verification, recorded with the ' +
    'reason. Refused when the player already has one requested, or has an advanced ' +
    'verification open or awaiting a decision. The request cannot be undone.',
  schemaVersion: 1,
  iam: { resource: 'compliance', action: 'override-limit' },
  reversible: false,
  payloadSchema: RequestEnhancedKycPayloadSchema,
  errors: ['player_not_found', 'already_requested', 'verification_in_progress'],
});
