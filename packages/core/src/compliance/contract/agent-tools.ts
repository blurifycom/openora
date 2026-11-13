import * as z from 'zod';
import {
  ExclusionKindSchema,
  KycStatusSchema,
  KycTierSchema,
  LimitChangeKindSchema,
  LimitPeriodSchema,
  LimitTypeSchema,
  MAX_RG_STANDING_WINDOW_DAYS,
  MAX_RG_STANDING_WINDOWS,
  MoneyAmountSchema,
  NonEmptyReasonSchema,
  RG_FLAG_TYPES,
  RgFlagTypeSchema,
  TimestampSchema,
  UuidSchema,
  defineActionType,
  defineMcpTool,
  type KycStatus,
} from '@openora/core/contracts';
import { KYC_DOCUMENT_TYPES, KycDocumentTypeSchema, KycTriggeredBySchema } from './enums.js';

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

/** At most this many queued items a queue tool lists, oldest first. */
export const COMPLIANCE_QUEUE_MAX_ITEMS = 20;

export const RgPlayerStateInputSchema = z.object({
  playerId: UuidSchema,
  windowDays: z
    .array(z.coerce.number().int().min(1).max(MAX_RG_STANDING_WINDOW_DAYS))
    .min(1)
    .max(MAX_RG_STANDING_WINDOWS)
    .default([7, 30, 90]),
});
export type RgPlayerStateInput = z.infer<typeof RgPlayerStateInputSchema>;

export const RgPlayerStateOutputSchema = z.object({
  playerId: UuidSchema,
  restricted: z.boolean(),
  activeExclusions: z
    .array(
      z.object({
        kind: ExclusionKindSchema,
        startsAt: TimestampSchema,
        expiresAt: TimestampSchema.nullable(),
        isPermanent: z.boolean(),
      }),
    )
    .max(4),
  selfExclusionsOnRecord: z.number().int().nonnegative(),
  lastSelfExclusionEndedAt: TimestampSchema.nullable(),
  lastCoolingOffEndedAt: TimestampSchema.nullable(),
  activeFlags: z
    .array(
      z.object({
        flagType: RgFlagTypeSchema,
        limitType: LimitTypeSchema.nullable(),
        flaggedAt: TimestampSchema,
      }),
    )
    .max(50),
  limits: z
    .array(
      z.object({
        type: LimitTypeSchema,
        period: LimitPeriodSchema,
        /** Money limits: the amount and its currency; null for the session limit. */
        amount: MoneyAmountSchema.nullable(),
        currency: z.string().nullable(),
        /** The session limit's minutes; null for a money limit. */
        minutes: z.number().int().nullable(),
        pendingKind: LimitChangeKindSchema.nullable(),
        pendingRequestedAt: TimestampSchema.nullable(),
      }),
    )
    .max(50),
  pivotCurrency: z.string(),
  windows: z
    .array(
      z.object({
        days: z.number().int(),
        totals: z
          .object({ deposits: MoneyAmountSchema, bets: MoneyAmountSchema, wins: MoneyAmountSchema })
          .nullable(),
      }),
    )
    .max(MAX_RG_STANDING_WINDOWS),
});
export type RgPlayerState = z.infer<typeof RgPlayerStateOutputSchema>;

export const rgPlayerStateTool = defineMcpTool({
  id: 'rg.player_state',
  title: 'Responsible gambling state',
  description:
    "A player's responsible-gambling standing, as facts with no conclusion drawn: restricted is " +
    'whether their wagers are refused now; activeExclusions are the self-exclusions and ' +
    'cooling-offs in force (expiresAt null for a permanent one); selfExclusionsOnRecord counts ' +
    'every self-exclusion they ever had, with when the last self-exclusion and cooling-off ' +
    'ended; activeFlags are the open monitoring flags; limits are the deposit, wager, loss and ' +
    'session limits as they apply now, with a raise or removal still waiting its cool-down; and ' +
    'windows are completed deposits, stakes and wins over each of windowDays (1 to 4 windows of 1 to 365 days, default 7, 30 and 90) priced into pivotCurrency, totals null when an amount cannot be priced. Amounts are decimal strings. No reason, note or admin is returned.',
  class: 'read',
  schemaVersion: 1,
  iam: { resource: 'compliance', action: 'view' },
  inputSchema: RgPlayerStateInputSchema,
  outputSchema: RgPlayerStateOutputSchema,
  redact: {
    allow: [
      'playerId',
      'restricted',
      'activeExclusions',
      'selfExclusionsOnRecord',
      'lastSelfExclusionEndedAt',
      'lastCoolingOffEndedAt',
      'activeFlags',
      'limits',
      'pivotCurrency',
      'windows',
    ],
  },
  errors: ['player_not_found'],
});

export const RgFlagsQueueInputSchema = z.object({
  flagType: RgFlagTypeSchema.optional(),
  limit: z.coerce.number().int().min(1).max(COMPLIANCE_QUEUE_MAX_ITEMS).default(10),
});
export type RgFlagsQueueInput = z.infer<typeof RgFlagsQueueInputSchema>;

export const RgFlagsQueueOutputSchema = z.object({
  activeCount: z.number().int().nonnegative(),
  activeByType: z
    .array(z.object({ flagType: RgFlagTypeSchema, count: z.number().int().positive() }))
    .max(RG_FLAG_TYPES.length),
  flaggedLast7Days: z.number().int().nonnegative(),
  oldest: z
    .array(
      z.object({
        flagId: UuidSchema,
        playerId: UuidSchema.nullable(),
        flagType: RgFlagTypeSchema,
        limitType: LimitTypeSchema.nullable(),
        flaggedAt: TimestampSchema,
        waitHours: z.number().nonnegative(),
      }),
    )
    .max(COMPLIANCE_QUEUE_MAX_ITEMS),
});
export type RgFlagsQueue = z.infer<typeof RgFlagsQueueOutputSchema>;

export const rgFlagsQueueTool = defineMcpTool({
  id: 'rg.flags_queue',
  title: 'Responsible gambling flags queue',
  description:
    'The open responsible-gambling monitoring flags across all players: how many are active, ' +
    'per flag type (limit_threshold: a player near or past a limit; session_time: a long ' +
    'session; self_excluded_login: a login attempt while self-excluded), how many were raised in ' +
    'the last 7 days, and the active ones waiting longest, oldest first (limit 1 to 20, default ' +
    '10; flagType narrows them), each with its flagId, playerId, flag type, the limit it is ' +
    "about and hours open. Use rg.player_state for one player's standing.",
  class: 'read',
  schemaVersion: 1,
  iam: { resource: 'compliance', action: 'view' },
  inputSchema: RgFlagsQueueInputSchema,
  outputSchema: RgFlagsQueueOutputSchema,
  redact: { allow: ['activeCount', 'activeByType', 'flaggedLast7Days', 'oldest'] },
  errors: [],
});

/** The KYC statuses the queue counts and lists: awaiting a decision, or the player's resubmission. */
export const KYC_QUEUE_STATUSES = [
  'pending',
  'resubmission_requested',
] as const satisfies readonly KycStatus[];
export const KycQueueStatusSchema = z.enum(KYC_QUEUE_STATUSES);
export type KycQueueStatus = z.infer<typeof KycQueueStatusSchema>;

export const KycQueueInputSchema = z.object({
  tier: KycTierSchema.optional(),
  status: KycQueueStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(COMPLIANCE_QUEUE_MAX_ITEMS).default(10),
});
export type KycQueueInput = z.infer<typeof KycQueueInputSchema>;

export const KycQueueOutputSchema = z.object({
  pendingCount: z.number().int().nonnegative(),
  resubmissionRequestedCount: z.number().int().nonnegative(),
  byTier: z
    .array(
      z.object({
        tier: KycTierSchema,
        pending: z.number().int().nonnegative(),
        resubmissionRequested: z.number().int().nonnegative(),
      }),
    )
    .max(2),
  avgPendingWaitHours: z.number().nonnegative().nullable(),
  oldest: z
    .array(
      z.object({
        verificationId: UuidSchema,
        playerId: UuidSchema.nullable(),
        tier: KycTierSchema,
        status: KycQueueStatusSchema,
        triggeredBy: KycTriggeredBySchema,
        documentTypes: z.array(KycDocumentTypeSchema).max(KYC_DOCUMENT_TYPES.length),
        submittedAt: TimestampSchema,
        waitHours: z.number().nonnegative(),
      }),
    )
    .max(COMPLIANCE_QUEUE_MAX_ITEMS),
});
export type KycQueue = z.infer<typeof KycQueueOutputSchema>;

export const kycQueueTool = defineMcpTool({
  id: 'kyc.queue',
  title: 'KYC queue',
  description:
    "The KYC verifications waiting across all players, each player's latest per tier: how many " +
    'are pending (awaiting a decision) and how many are resubmission_requested (waiting for the ' +
    'player to resubmit), per tier (basic, or advanced - enhanced KYC), the average hours the ' +
    'pending ones have waited, and the waiting ones submitted longest ago, oldest first (limit 1 ' +
    'to 20, default 10; both statuses unless status names one, tier narrows them too). Each ' +
    'listed one carries its verificationId and playerId, tier, status, what triggered it, the ' +
    "document types submitted and hours since submission. Use kyc.status for one player's " +
    'standing. No decision reason, document or personal data is returned.',
  class: 'read',
  schemaVersion: 1,
  iam: { resource: 'compliance', action: 'view' },
  inputSchema: KycQueueInputSchema,
  outputSchema: KycQueueOutputSchema,
  redact: {
    allow: [
      'pendingCount',
      'resubmissionRequestedCount',
      'byTier',
      'avgPendingWaitHours',
      'oldest',
    ],
  },
  errors: [],
});
