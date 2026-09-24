import { eventIterator, oc } from '@orpc/contract';
import * as z from 'zod';
import {
  UuidSchema,
  KycStatusSchema,
  KycTierSchema,
  KycCheckResultSchema,
  TimestampSchema,
  CountryCodeSchema,
  GameBulkIdsSchema,
  GeoRuleActionSchema,
  NonEmptyReasonSchema,
  PageQuerySchema,
  paginated,
} from '@openora/core/contracts';
import { KYC_DOCUMENT_TYPES, KYC_TRIGGERED_BY } from './enums.js';
import { LimitSchema, LimitViewSchema, UpsertLimitInputSchema } from './limits.js';
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
  tier: KycTierSchema,
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
  tier: KycTierSchema,
  documents: z.array(KycDocumentSchema),
});
export type SubmitKycInput = z.infer<typeof SubmitKycInputSchema>;

export const SubmitKycOutputSchema = KycVerificationSchema.extend({
  verificationUrl: z.string().optional(),
});
export type SubmitKycOutput = z.infer<typeof SubmitKycOutputSchema>;

export const PlayerKycViewSchema = z.object({
  basic: z.object({
    current: KycVerificationSchema.nullable(),
    history: z.array(KycVerificationSchema),
  }),
  advanced: z.object({
    current: KycVerificationSchema.nullable(),
    history: z.array(KycVerificationSchema),
  }),
});
export type PlayerKycView = z.infer<typeof PlayerKycViewSchema>;
export type KycVerification = z.infer<typeof KycVerificationSchema>;

// Player-facing projection of KycVerificationSchema: no riskSignals, checks, decisionReason,
// provider, or referenceId - those are fraud-detection internals, admin-only via getPlayerKyc.
// `exempt` is a narrow, player-safe derivation of `triggeredBy === 'exemption'` - it tells the
// player their approval came from a jurisdiction rule rather than exposing the internal field.
export const KycVerificationSummarySchema = z.object({
  tier: KycTierSchema,
  status: KycStatusSchema,
  documentTypes: z.array(KycDocumentTypeSchema),
  exempt: z.boolean(),
  submittedAt: TimestampSchema,
  decidedAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type KycVerificationSummary = z.infer<typeof KycVerificationSummarySchema>;

export const PlayerKycSummaryViewSchema = z.object({
  basic: z.object({
    current: KycVerificationSummarySchema.nullable(),
    history: z.array(KycVerificationSummarySchema),
  }),
  advanced: z.object({
    current: KycVerificationSummarySchema.nullable(),
    history: z.array(KycVerificationSummarySchema),
  }),
});
export type PlayerKycSummaryView = z.infer<typeof PlayerKycSummaryViewSchema>;

export const KycStatusUpdateSchema = z.object({
  eventId: UuidSchema,
  status: KycStatusSchema,
  tier: KycTierSchema,
});
export type KycStatusUpdate = z.infer<typeof KycStatusUpdateSchema>;

export const RequestKycResubmissionInputSchema = z.object({
  userId: UuidSchema,
  tier: KycTierSchema,
  reason: NonEmptyReasonSchema,
});
export type RequestKycResubmissionInput = z.infer<typeof RequestKycResubmissionInputSchema>;

export const KycOverrideStatusSchema = KycStatusSchema.exclude(['verified', 'manually_overridden']);
export type KycOverrideStatus = z.infer<typeof KycOverrideStatusSchema>;

export const OverrideKycStatusInputSchema = z.object({
  userId: UuidSchema,
  tier: KycTierSchema,
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
  tier: KycTierSchema,
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

export const CountryRuleSchema = z.object({
  id: UuidSchema,
  countryCode: CountryCodeSchema,
  blacklisted: z.boolean(),
  redirectIp: z.boolean(),
  kycRequired: z.boolean(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema.nullable(),
  updatedBy: UuidSchema.nullable(),
});
export type CountryRule = z.infer<typeof CountryRuleSchema>;

export const GeoRuleSchema = z.object({
  id: UuidSchema,
  countryCode: CountryCodeSchema,
  action: GeoRuleActionSchema,
  createdAt: TimestampSchema,
});
export type GeoRule = z.infer<typeof GeoRuleSchema>;

export const GameGeoRuleSchema = z.object({
  id: UuidSchema,
  gameId: UuidSchema,
  countryCode: CountryCodeSchema,
  reason: NonEmptyReasonSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type GameGeoRule = z.infer<typeof GameGeoRuleSchema>;

export const ProviderGeoRuleSchema = z.object({
  id: UuidSchema,
  providerId: UuidSchema,
  countryCode: CountryCodeSchema,
  reason: NonEmptyReasonSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type ProviderGeoRule = z.infer<typeof ProviderGeoRuleSchema>;

const DeleteLimitInputSchema = LimitSchema.pick({ id: true });

export const AddGeoRuleInputSchema = GeoRuleSchema.pick({ countryCode: true, action: true })
  .extend({ confirm: z.literal(true).optional() })
  .strict();
export type AddGeoRuleInput = z.infer<typeof AddGeoRuleInputSchema>;

export const UpsertCountryRuleInputSchema = CountryRuleSchema.pick({
  countryCode: true,
  blacklisted: true,
  redirectIp: true,
  kycRequired: true,
})
  .extend({
    expectedUpdatedAt: TimestampSchema.nullable(),
    confirm: z.boolean().optional(),
  })
  .strict();
export type UpsertCountryRuleInput = z.infer<typeof UpsertCountryRuleInputSchema>;

export const GlobalKycConfigSchema = z.object({
  enabled: z.boolean(),
  updatedAt: TimestampSchema.nullable(),
  updatedBy: UuidSchema.nullable(),
});
export type GlobalKycConfig = z.infer<typeof GlobalKycConfigSchema>;

export const SetGlobalKycConfigInputSchema = z
  .object({
    enabled: z.boolean(),
    confirm: z.literal(true),
    expectedUpdatedAt: TimestampSchema.nullable(),
  })
  .strict();
export type SetGlobalKycConfigInput = z.infer<typeof SetGlobalKycConfigInputSchema>;

// ISO 3166-1 alpha-2 assigns 249 codes; the cap lets one request cover every country.
const GeoRuleCountryCodesSchema = z.array(CountryCodeSchema).min(1).max(250);

export const UpsertGameGeoRulesInputSchema = GameGeoRuleSchema.pick({
  gameId: true,
  reason: true,
}).extend({ countryCodes: GeoRuleCountryCodesSchema });
export type UpsertGameGeoRulesInput = z.infer<typeof UpsertGameGeoRulesInputSchema>;

export const DeleteGameGeoRulesInputSchema = GameGeoRuleSchema.pick({
  gameId: true,
  reason: true,
}).extend({ countryCodes: GeoRuleCountryCodesSchema });
export type DeleteGameGeoRulesInput = z.infer<typeof DeleteGameGeoRulesInputSchema>;

export const ListGameGeoRulesInputSchema = PageQuerySchema.extend({
  gameIds: z.array(UuidSchema).min(1).max(100).optional(),
});
export type ListGameGeoRulesInput = z.infer<typeof ListGameGeoRulesInputSchema>;

export const UpsertProviderGeoRulesInputSchema = ProviderGeoRuleSchema.pick({
  providerId: true,
  reason: true,
}).extend({ countryCodes: GeoRuleCountryCodesSchema });
export type UpsertProviderGeoRulesInput = z.infer<typeof UpsertProviderGeoRulesInputSchema>;

export const DeleteProviderGeoRulesInputSchema = ProviderGeoRuleSchema.pick({
  providerId: true,
  reason: true,
}).extend({ countryCodes: GeoRuleCountryCodesSchema });
export type DeleteProviderGeoRulesInput = z.infer<typeof DeleteProviderGeoRulesInputSchema>;

export const ListProviderGeoRulesInputSchema = PageQuerySchema.extend({
  providerIds: z.array(UuidSchema).min(1).max(100).optional(),
});
export type ListProviderGeoRulesInput = z.infer<typeof ListProviderGeoRulesInputSchema>;

const GeoCheckOutputSchema = z.object({
  allowed: z.boolean(),
  countryCode: CountryCodeSchema.nullable(),
  reason: z.string().nullable(),
});

export const GetBlockedCountriesOutputSchema = z.object({
  countryCodes: z.array(CountryCodeSchema),
});
export type GetBlockedCountriesOutput = z.infer<typeof GetBlockedCountriesOutputSchema>;

export const BulkGameGeoRuleInputSchema = z
  .object({
    providerIds: z.array(UuidSchema).max(50).optional(),
    gameIds: z.array(UuidSchema).max(500).optional(),
    countryCode: CountryCodeSchema,
    reason: NonEmptyReasonSchema.max(500),
  })
  .refine((target) => (target.providerIds?.length ?? 0) > 0 || (target.gameIds?.length ?? 0) > 0, {
    message: 'Provide at least one non-empty providerIds or gameIds',
    path: ['gameIds'],
  });
export type BulkGameGeoRuleInput = z.infer<typeof BulkGameGeoRuleInputSchema>;

export const BulkRestrictGameGeoRulesOutputSchema = z.object({
  changed: z.number().int().nonnegative(),
  unchanged: z.number().int().nonnegative(),
  notFound: GameBulkIdsSchema,
});
export type BulkRestrictGameGeoRulesOutput = z.infer<typeof BulkRestrictGameGeoRulesOutputSchema>;

export const BulkUnrestrictGameGeoRulesOutputSchema = BulkRestrictGameGeoRulesOutputSchema.extend({
  stillBlockedByProvider: z.number().int().nonnegative(),
  globallyBlocked: z.boolean(),
});
export type BulkUnrestrictGameGeoRulesOutput = z.infer<
  typeof BulkUnrestrictGameGeoRulesOutputSchema
>;

export const complianceContract = {
  getLimits: oc
    .route({ method: 'GET', path: '/compliance/limits' })
    .output(z.array(LimitViewSchema)),

  upsertLimit: oc
    .route({ method: 'PUT', path: '/compliance/limits' })
    .input(UpsertLimitInputSchema)
    .output(LimitViewSchema),

  deleteLimit: oc
    .route({ method: 'DELETE', path: '/compliance/limits/{id}' })
    .input(DeleteLimitInputSchema)
    .output(LimitViewSchema),

  geoCheck: oc.route({ method: 'GET', path: '/compliance/geo-check' }).output(GeoCheckOutputSchema),

  addGeoRule: oc
    .route({ method: 'POST', path: '/compliance/geo-rules' })
    .input(AddGeoRuleInputSchema)
    .output(GeoRuleSchema),

  listGeoRules: oc
    .route({ method: 'GET', path: '/compliance/geo-rules' })
    .output(z.array(GeoRuleSchema)),

  upsertGameGeoRules: oc
    .route({ method: 'PUT', path: '/compliance/game-geo-rules/{gameId}' })
    .input(UpsertGameGeoRulesInputSchema)
    .output(z.array(GameGeoRuleSchema)),

  deleteGameGeoRules: oc
    .route({ method: 'DELETE', path: '/compliance/game-geo-rules/{gameId}' })
    .input(DeleteGameGeoRulesInputSchema)
    .output(z.array(GameGeoRuleSchema)),

  listGameGeoRules: oc
    .route({ method: 'GET', path: '/compliance/game-geo-rules' })
    .input(ListGameGeoRulesInputSchema)
    .output(paginated(GameGeoRuleSchema)),

  bulkRestrictGameGeoRules: oc
    .route({ method: 'POST', path: '/compliance/game-geo-rules/bulk/restrict' })
    .input(BulkGameGeoRuleInputSchema)
    .output(BulkRestrictGameGeoRulesOutputSchema),

  bulkUnrestrictGameGeoRules: oc
    .route({ method: 'POST', path: '/compliance/game-geo-rules/bulk/unrestrict' })
    .input(BulkGameGeoRuleInputSchema)
    .output(BulkUnrestrictGameGeoRulesOutputSchema),

  getBlockedCountries: oc
    .route({ method: 'GET', path: '/compliance/blocked-countries' })
    .output(GetBlockedCountriesOutputSchema),

  upsertProviderGeoRules: oc
    .route({ method: 'PUT', path: '/compliance/provider-geo-rules/{providerId}' })
    .input(UpsertProviderGeoRulesInputSchema)
    .output(z.array(ProviderGeoRuleSchema)),

  deleteProviderGeoRules: oc
    .route({ method: 'DELETE', path: '/compliance/provider-geo-rules/{providerId}' })
    .input(DeleteProviderGeoRulesInputSchema)
    .output(z.array(ProviderGeoRuleSchema)),

  listProviderGeoRules: oc
    .route({ method: 'GET', path: '/compliance/provider-geo-rules' })
    .input(ListProviderGeoRulesInputSchema)
    .output(paginated(ProviderGeoRuleSchema)),

  upsertCountryRule: oc
    .route({ method: 'PUT', path: '/compliance/country-rules' })
    .input(UpsertCountryRuleInputSchema)
    .output(CountryRuleSchema),

  listCountryRules: oc
    .route({ method: 'GET', path: '/compliance/country-rules' })
    .output(z.array(CountryRuleSchema)),

  getGlobalKycConfig: oc
    .route({ method: 'GET', path: '/compliance/global-kyc' })
    .output(GlobalKycConfigSchema),

  setGlobalKycConfig: oc
    .route({ method: 'PUT', path: '/compliance/global-kyc' })
    .input(SetGlobalKycConfigInputSchema)
    .output(GlobalKycConfigSchema),

  getPlayerKyc: oc
    .route({ method: 'GET', path: '/compliance/players/{userId}/kyc' })
    .input(z.object({ userId: UuidSchema }))
    .output(PlayerKycViewSchema),

  getMyKyc: oc
    .route({ method: 'GET', path: '/compliance/kyc/me' })
    .output(PlayerKycSummaryViewSchema),

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
