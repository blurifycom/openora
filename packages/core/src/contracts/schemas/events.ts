import * as z from 'zod';
import { isWagerRtp, WagerProductSchema } from '../adapters/wager-context.js';
import {
  ClientMetaSchema,
  CurrencyTickerSchema,
  MoneyAmountSchema,
  TimestampSchema,
  UuidSchema,
} from './common.js';
import {
  GameAddedCategoryLinksSchema,
  GameAddedTagLinksSchema,
  GameBulkIdsSchema,
  GameCategoryMembershipModeSchema,
  GameCategoryMembershipTriggerSchema,
  GameCategoryRuleSchema,
  GameCategoryTranslationsSchema,
  GameProviderAggregatorMappingSchema,
  GameReviewDecisionSchema,
  GameReviewStatusSchema,
  GameSortDirectionSchema,
  GameSortKeySchema,
  GameSortParamsSchema,
  GameTagSnapshotSchema,
  GAME_TYPES,
} from './game.js';
import {
  GEO_RULE_ADMIN_SOURCE,
  GeoRuleActionSchema,
  GeoRuleSourceSchema,
  LimitTypeSchema,
  LimitPeriodSchema,
  LimitChangeKindSchema,
  RgInitiatorSchema,
  ExclusionKindSchema,
  NonEmptyReasonSchema,
} from './compliance.js';
import {
  DEFAULT_LOBBY_LAYOUT_KEY,
  LobbyLayoutKeySchema,
  LobbyLayoutSnapshotSchema,
} from './lobby.js';
import { PlayEligibilitySnapshotSchema, RgLimitsSnapshotSchema } from './ledger.js';
import { CountryCodeSchema } from './igaming-config.js';
import { TagKeySchema } from './tag.js';
import { PermissionLevelSchema } from './iam.js';
import {
  AutoLogoutDurationSchema,
  RegistrationFailureReasonSchema,
  UsernameSchema,
} from './identity.js';
import {
  KycStatusSchema,
  KycStatusSourceSchema,
  KycTierSchema,
  PlayerStatusSchema,
} from './player.js';
import { WalletTransactionTypeSchema } from './wallet-tx.js';
import {
  SportsbookBetLegSchema,
  SportsbookBetResultSchema,
  SportsbookCancelReasonSchema,
  SportsbookDebtCauseSchema,
  SportsbookProviderIdSchema,
  SportsbookProviderNameSchema,
  SportsbookPromotionSchema,
} from './sportsbook.js';
import {
  BonusForfeitReasonSchema,
  BonusGrantSourceSchema,
  ContributionPercentSchema,
  RANK_PERIODIC_BASES,
  RANK_PERIODIC_REWARD_KINDS,
  RANK_PERIODIC_REWARD_STATUSES,
} from './promo.js';
import { CommandMetadataSchema } from './chat-command.js';
import { SystemEventMetadataSchema } from './chat-command-metadata.js';
import { ChatContextRefSchema, EnsureChatContextRoomInputSchema } from './chat-context-room.js';

const authContextBase = ClientMetaSchema.partial();
const lobbyLayoutAuditSnapshotSchema = LobbyLayoutSnapshotSchema;

const iamRoleEventBase = z
  .object({ roleId: UuidSchema, actorId: UuidSchema })
  .extend(authContextBase.shape);
const cmsPageEventBase = z
  .object({ pageId: UuidSchema, actorId: UuidSchema })
  .extend(authContextBase.shape);
const cmsBannerConfigurationEventBase = z
  .object({ bannerConfigurationId: UuidSchema, actorId: UuidSchema })
  .extend(authContextBase.shape);
const cmsBannerImageEventBase = z
  .object({ bannerImageId: UuidSchema, bannerConfigurationId: UuidSchema, actorId: UuidSchema })
  .extend(authContextBase.shape);
const droppedImageUrlsSchema = z.array(z.url()).default([]);
const cmsBannerScheduleEventBase = z
  .object({
    bannerScheduleId: UuidSchema,
    bannerConfigurationId: UuidSchema,
    placement: z.string(),
    startsAt: TimestampSchema,
    endsAt: TimestampSchema,
    actorId: UuidSchema,
  })
  .extend(authContextBase.shape);
const cmsBannerScheduleUpdatedEvent = cmsBannerScheduleEventBase.extend({
  before: z.object({ endsAt: TimestampSchema }),
});
const actorReasonBase = z.object({ actorId: UuidSchema, reason: z.string() });
const tagPlayerEventBase = actorReasonBase
  .extend({
    playerId: UuidSchema,
    tagKey: TagKeySchema,
    auditRecorded: z.literal(true).optional(),
  })
  .extend(authContextBase.shape);
const permissionLevelEntries = z.array(
  z.object({ resource: z.string(), level: PermissionLevelSchema }),
);

const gameBulkEventBase = z
  .object({ actorId: UuidSchema, target: GameBulkIdsSchema, notFound: GameBulkIdsSchema })
  .extend(authContextBase.shape);

const gameProviderSnapshotSchema = z.object({
  slug: z.string(),
  name: z.string(),
  aggregatorMappings: z.array(GameProviderAggregatorMappingSchema),
  logoUrl: z.string().nullable(),
  customLogoUrl: z.string().nullable().default(null),
  metadata: z.unknown().nullable(),
  isActive: z.boolean(),
  autoApproveNewGames: z.boolean().default(false),
});

const gameGeoRuleEventState = z.object({
  id: UuidSchema,
  gameId: UuidSchema,
  countryCode: CountryCodeSchema,
  reason: NonEmptyReasonSchema,
  source: GeoRuleSourceSchema.default(GEO_RULE_ADMIN_SOURCE),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

const providerGeoRuleEventState = gameGeoRuleEventState
  .omit({ gameId: true, source: true })
  .extend({ providerId: UuidSchema });

const gameCategorySnapshotSchema = z.object({
  slug: z.string(),
  name: z.string(),
  translations: GameCategoryTranslationsSchema.optional(),
  icon: z.string().nullable(),
  sortOrder: z.number().int(),
  isActive: z.boolean(),
  sortKey: GameSortKeySchema.default('manual'),
  sortDirection: GameSortDirectionSchema.nullable().default(null),
  sortParams: GameSortParamsSchema.default({}),
  rankedAt: z.string().nullable().default(null),
  membershipMode: GameCategoryMembershipModeSchema.default('manual'),
  membershipRule: GameCategoryRuleSchema.nullable().default(null),
});

const walletTxnBase = z.object({
  userId: UuidSchema,
  amount: MoneyAmountSchema,
  currency: CurrencyTickerSchema,
  transactionId: UuidSchema,
});

export const WITHDRAWAL_REQUEUE_REASONS = [
  'withdrawal_hold',
  'withdrawal_lock',
  'withdrawal_pin_locked',
  'kyc_required',
  'control_check_failed',
  'never_dispatched',
] as const;
export type WithdrawalRequeueReason = (typeof WITHDRAWAL_REQUEUE_REASONS)[number];

const limitChangeBase = authContextBase.extend({
  userId: UuidSchema,
  playerId: UuidSchema.nullable(),
  limitId: UuidSchema,
  type: LimitTypeSchema,
  period: LimitPeriodSchema,
  kind: LimitChangeKindSchema,
  previousAmount: MoneyAmountSchema.nullable(),
  previousMinutes: z.number().int().nullable(),
  requestedAmount: MoneyAmountSchema.nullable(),
  requestedMinutes: z.number().int().nullable(),
});

export const KycStatusUpdatedSchema = z.object({
  userId: UuidSchema,
  playerId: UuidSchema.nullable(),
  actorId: UuidSchema.nullable(),
  status: KycStatusSchema,
  previousStatus: KycStatusSchema,
  reason: z.string().nullable(),
  source: KycStatusSourceSchema,
  auditRecorded: z.literal(true).optional(),
  tier: KycTierSchema.default('basic'),
});

export const TWO_FACTOR_METHODS = ['totp', 'otp', 'backup_code', 'webauthn'] as const;
export const TwoFactorMethodSchema = z.enum(TWO_FACTOR_METHODS);
export type TwoFactorMethod = z.infer<typeof TwoFactorMethodSchema>;

export const AUTHENTICATION_METHODS = [
  'password',
  'email_verification',
  'phone',
  'totp',
  'otp',
  'backup_code',
] as const;
export const AuthenticationMethodSchema = z.enum(AUTHENTICATION_METHODS);
export type AuthenticationMethod = z.infer<typeof AuthenticationMethodSchema>;

const sportsbookBetBase = z.object({
  betId: UuidSchema,
  userId: UuidSchema,
  playerId: UuidSchema.nullable(),
  provider: SportsbookProviderNameSchema,
  providerBetId: SportsbookProviderIdSchema,
  providerTxId: SportsbookProviderIdSchema,
  currency: CurrencyTickerSchema,
  version: z.number().int().positive(),
  auditRecorded: z.literal(true).optional(),
});

export const domainEventSchemas = {
  'identity.user.registered': authContextBase.extend({
    userId: UuidSchema,
    playerId: UuidSchema.nullable(),
    countryCode: CountryCodeSchema.nullable().optional(),
    termsVersion: z.string().optional(),
    acceptedTerms: z.literal(true).optional(),
    acceptedAge: z.literal(true).optional(),
  }),
  'identity.user.registration.failed': authContextBase.extend({
    email: z.email(),
    username: UsernameSchema.optional(),
    reason: RegistrationFailureReasonSchema,
  }),
  'identity.user.login': authContextBase.extend({
    userId: UuidSchema,
    playerId: UuidSchema.nullable(),
  }),
  'identity.authentication.succeeded': authContextBase.extend({
    userId: UuidSchema,
    playerId: UuidSchema.nullable(),
    method: AuthenticationMethodSchema,
  }),
  'identity.user.login.failed': authContextBase.extend({
    email: z.email(),
    reason: z.string().nullable().optional(),
    attemptsRemaining: z.number().int().optional(),
    countryCode: CountryCodeSchema.nullable().optional(),
  }),
  'identity.user.logout': authContextBase.extend({
    userId: UuidSchema,
    playerId: UuidSchema.nullable(),
  }),
  'identity.user.phone_login': authContextBase.extend({
    userId: UuidSchema,
    playerId: UuidSchema.nullable(),
    method: z.literal('phone'),
  }),
  'identity.phone_otp.requested': authContextBase.extend({ userId: UuidSchema }),
  'identity.phone_otp.cancelled': authContextBase.extend({
    userId: UuidSchema,
    reason: z.enum(['max_attempts', 'new_otp_requested']),
  }),
  'identity.user.lockout.triggered': authContextBase.extend({
    userId: UuidSchema,
    email: z.email(),
    tier: z.number().int().positive().optional(),
    lockoutUntil: TimestampSchema,
  }),
  'identity.user.unlocked': authContextBase.extend({
    userId: UuidSchema,
    email: z.email(),
    actorId: UuidSchema,
    previousFailedAttempts: z.number().int().optional(),
    previousLockoutUntil: TimestampSchema.nullable().optional(),
  }),
  'identity.2fa.enabled': authContextBase.extend({
    userId: UuidSchema,
    playerId: UuidSchema.nullable(),
    method: TwoFactorMethodSchema,
  }),
  'identity.2fa.disabled': authContextBase.extend({
    userId: UuidSchema,
    playerId: UuidSchema.nullable(),
    method: TwoFactorMethodSchema,
    stepUpMethod: TwoFactorMethodSchema,
  }),
  'identity.2fa.verified': authContextBase.extend({
    userId: UuidSchema,
    playerId: UuidSchema.nullable(),
    method: TwoFactorMethodSchema,
    trustedDevice: z.boolean(),
  }),
  'identity.2fa.failed': authContextBase.extend({
    userId: UuidSchema,
    playerId: UuidSchema.nullable(),
    method: TwoFactorMethodSchema,
    attemptsRemaining: z.number().int().nonnegative(),
  }),
  'identity.2fa.backup_codes_regenerated': authContextBase.extend({
    userId: UuidSchema,
    playerId: UuidSchema.nullable(),
    stepUpMethod: TwoFactorMethodSchema,
  }),
  'identity.2fa.reset': authContextBase.extend({
    userId: UuidSchema,
    playerId: UuidSchema.nullable(),
    actorId: UuidSchema,
    reason: z.string(),
  }),
  'identity.2fa.lockout.triggered': authContextBase.extend({
    userId: UuidSchema,
    playerId: UuidSchema.nullable(),
    lockoutUntil: TimestampSchema,
  }),
  'identity.2fa.enrollment_blocked': authContextBase.extend({
    userId: UuidSchema,
  }),
  'identity.session.fingerprint_mismatch': authContextBase.extend({
    userId: UuidSchema,
    playerId: UuidSchema.nullable(),
    sessionId: UuidSchema,
    mismatch: z.enum(['user_agent', 'ip']),
  }),
  'identity.trusted_device.added': authContextBase.extend({
    userId: UuidSchema,
    playerId: UuidSchema.nullable(),
    deviceId: UuidSchema,
    label: z.string(),
    expiresAt: TimestampSchema,
  }),
  'identity.trusted_device.revoked': authContextBase.extend({
    userId: UuidSchema,
    playerId: UuidSchema.nullable(),
    deviceId: UuidSchema,
    actorId: UuidSchema.optional(),
  }),
  'identity.password.reset': authContextBase.extend({
    userId: UuidSchema,
    playerId: UuidSchema.nullable(),
  }),
  'identity.password.changed': authContextBase.extend({
    userId: UuidSchema,
    playerId: UuidSchema.nullable(),
  }),
  'identity.email.verified': authContextBase.extend({
    userId: UuidSchema,
    playerId: UuidSchema.nullable(),
  }),
  'identity.email.changed': authContextBase.extend({
    userId: UuidSchema,
    playerId: UuidSchema.nullable(),
    previousEmail: z.email(),
    newEmail: z.email(),
    changedAt: TimestampSchema.optional(),
    auditRecorded: z.literal(true).optional(),
  }),
  'identity.phone.verified': authContextBase.extend({
    userId: UuidSchema,
    playerId: UuidSchema.nullable(),
    previousPhoneVerified: z.boolean(),
  }),
  'identity.security.login_withdrawal_alerts.updated': authContextBase.extend({
    userId: UuidSchema,
    playerId: UuidSchema.nullable(),
    previousEnabled: z.boolean(),
    enabled: z.boolean(),
  }),
  'identity.security.auto_logout.updated': authContextBase.extend({
    userId: UuidSchema,
    playerId: UuidSchema.nullable(),
    previousDuration: AutoLogoutDurationSchema,
    duration: AutoLogoutDurationSchema,
  }),
  'identity.security.require_two_factor.updated': authContextBase.extend({
    userId: UuidSchema,
    playerId: UuidSchema.nullable(),
    previousEnabled: z.boolean(),
    enabled: z.boolean(),
  }),
  'identity.security.withdrawal_pin.set': authContextBase.extend({
    userId: UuidSchema,
    playerId: UuidSchema.nullable(),
    wasAlreadySet: z.boolean(),
  }),
  'identity.security.withdrawal_pin.removed': authContextBase.extend({
    userId: UuidSchema,
    playerId: UuidSchema.nullable(),
  }),
  'identity.security.withdrawal_pin.locked': authContextBase.extend({
    userId: UuidSchema,
    playerId: UuidSchema.nullable(),
    lockedUntil: TimestampSchema,
  }),
  'identity.security.anti_phishing_code.set': authContextBase.extend({
    userId: UuidSchema,
    playerId: UuidSchema.nullable(),
    wasAlreadySet: z.boolean(),
  }),
  'identity.profile.updated': authContextBase.extend({
    userId: UuidSchema,
    playerId: UuidSchema.nullable(),
  }),
  'identity.play_eligibility.changed': PlayEligibilitySnapshotSchema,
  'compliance.rg_limits.changed': RgLimitsSnapshotSchema,
  'identity.user.deactivated': authContextBase.extend({ userId: UuidSchema, actorId: UuidSchema }),
  'identity.user.reactivated': authContextBase.extend({ userId: UuidSchema, actorId: UuidSchema }),
  'identity.session.revoked': authContextBase.extend({
    userId: UuidSchema,
    playerId: UuidSchema.nullable(),
    sessionId: UuidSchema,
    actorId: UuidSchema.optional(),
  }),
  'identity.sessions.revoked_all': authContextBase.extend({
    userId: UuidSchema,
    playerId: UuidSchema.nullable(),
    actorId: UuidSchema.optional(),
    exceptSessionId: UuidSchema.optional(),
  }),
  'identity.user.login_blocked': authContextBase.extend({
    userId: UuidSchema,
    playerId: UuidSchema.nullable(),
    reason: z.literal('inactive'),
  }),
  'identity.user.unauthorized_access': authContextBase.extend({
    userId: UuidSchema,
    playerId: UuidSchema.nullable(),
    resource: z.string(),
    action: z.string(),
    role: z.string().optional(),
  }),
  'identity.password.admin_reset_requested': authContextBase.extend({
    userId: UuidSchema,
    email: z.email(),
    actorId: UuidSchema,
  }),

  'wallet.deposit.completed': walletTxnBase.extend({ playerId: UuidSchema.nullable() }),
  'wallet.deposit.held': walletTxnBase.extend({ playerId: UuidSchema.nullable() }),
  'wallet.withdrawal.completed': walletTxnBase.extend({ playerId: UuidSchema.nullable() }),
  'wallet.withdrawal.requested': walletTxnBase
    .extend({ playerId: UuidSchema.nullable() })
    .extend(authContextBase.shape),
  'wallet.withdrawal.approved': walletTxnBase
    .extend({ playerId: UuidSchema.nullable(), adminId: UuidSchema })
    .extend(authContextBase.shape),
  'wallet.withdrawal.rejected': walletTxnBase
    .extend({ playerId: UuidSchema.nullable(), adminId: UuidSchema, reason: z.string() })
    .extend(authContextBase.shape),
  'wallet.withdrawal.failed': walletTxnBase.extend({
    playerId: UuidSchema.nullable(),
    adminId: UuidSchema.nullable(),
  }),
  'wallet.withdrawal.requeued': walletTxnBase.extend({
    playerId: UuidSchema.nullable(),
    reason: z.enum(WITHDRAWAL_REQUEUE_REASONS),
  }),
  'wallet.manual_adjustment.created': walletTxnBase
    .extend({
      playerId: UuidSchema.nullable(),
      adminId: UuidSchema,
      direction: z.enum(['credit', 'debit']),
      reason: z.string(),
    })
    .extend(authContextBase.shape),
  'wallet.balance.changed': walletTxnBase.extend({
    playerId: UuidSchema.nullable(),
    type: WalletTransactionTypeSchema,
    direction: z.enum(['credit', 'debit']),
  }),
  'wallet.reconciliation.alert': z.object({
    runId: UuidSchema,
    openFindings: z.number().int().nonnegative(),
    threshold: z.number().int().nonnegative(),
    failedChecks: z.array(z.string()).optional(),
    projectionRepairsDeferred: z.number().int().nonnegative().optional(),
  }),

  'gaming.round.started': z.object({
    roundId: UuidSchema,
    gameId: UuidSchema,
    userId: UuidSchema,
    playerId: UuidSchema.nullable(),
    currency: CurrencyTickerSchema,
  }),
  'gaming.round.ended': z.object({
    roundId: UuidSchema,
    userId: UuidSchema,
    playerId: UuidSchema.nullable(),
  }),

  'sportsbook.bet.placed': sportsbookBetBase.extend({
    stake: MoneyAmountSchema,
    promotion: SportsbookPromotionSchema.optional(),
  }),
  'sportsbook.bet.accepted': sportsbookBetBase.extend({
    potentialPayout: MoneyAmountSchema,
    legs: z.array(SportsbookBetLegSchema).optional(),
    promotionPotential: MoneyAmountSchema.optional(),
  }),
  'sportsbook.bet.cancelled': sportsbookBetBase.extend({
    reason: SportsbookCancelReasonSchema,
    refunded: MoneyAmountSchema,
  }),
  'sportsbook.bet.settled': sportsbookBetBase.extend({
    result: SportsbookBetResultSchema,
    payout: MoneyAmountSchema,
    promotionAmount: MoneyAmountSchema.optional(),
  }),
  'sportsbook.bet.reopened': sportsbookBetBase.extend({
    collected: MoneyAmountSchema,
    shortfall: MoneyAmountSchema,
  }),
  'sportsbook.restriction.changed': authContextBase.extend({
    userId: UuidSchema,
    restricted: z.boolean(),
    reason: z.string().nullable(),
    actorId: UuidSchema,
    auditRecorded: z.literal(true).optional(),
  }),
  'sportsbook.debt.changed': z.object({
    debtId: UuidSchema,
    userId: UuidSchema,
    currency: CurrencyTickerSchema,
    cause: SportsbookDebtCauseSchema,
    amount: MoneyAmountSchema,
    outstanding: MoneyAmountSchema,
    actorId: UuidSchema.nullable(),
    auditRecorded: z.literal(true).optional(),
  }),

  'lobby.layout.updated': authContextBase.extend({
    actorId: UuidSchema.optional(),
    layoutKey: LobbyLayoutKeySchema.default(DEFAULT_LOBBY_LAYOUT_KEY),
    before: lobbyLayoutAuditSnapshotSchema,
    after: lobbyLayoutAuditSnapshotSchema,
  }),
  'gaming.provider.created': authContextBase.extend(gameProviderSnapshotSchema.shape).extend({
    providerId: UuidSchema,
    actorId: UuidSchema,
  }),
  'gaming.provider.updated': authContextBase.extend({
    providerId: UuidSchema,
    actorId: UuidSchema,
    bulkOperationId: UuidSchema.optional(),
    before: gameProviderSnapshotSchema,
    after: gameProviderSnapshotSchema,
  }),
  'gaming.category.created': authContextBase.extend(gameCategorySnapshotSchema.shape).extend({
    categoryId: UuidSchema,
    actorId: UuidSchema,
  }),
  'gaming.category.updated': authContextBase.extend({
    categoryId: UuidSchema,
    actorId: UuidSchema,
    before: gameCategorySnapshotSchema,
    after: gameCategorySnapshotSchema,
  }),
  'gaming.category.games_reordered': authContextBase.extend({
    categoryId: UuidSchema,
    actorId: UuidSchema,
    before: z.array(UuidSchema),
    after: z.array(UuidSchema),
    sortKeyBefore: GameSortKeySchema.default('manual'),
    sortKeyAfter: GameSortKeySchema.default('manual'),
    sortDirectionBefore: GameSortDirectionSchema.nullable().default(null),
    sortDirectionAfter: GameSortDirectionSchema.nullable().default(null),
    sortParamsBefore: GameSortParamsSchema.default({}),
    sortParamsAfter: GameSortParamsSchema.default({}),
  }),
  'gaming.category.pins_updated': authContextBase.extend({
    categoryId: UuidSchema,
    actorId: UuidSchema,
    before: z.array(z.object({ gameId: UuidSchema, position: z.number().int().nonnegative() })),
    after: z.array(z.object({ gameId: UuidSchema, position: z.number().int().nonnegative() })),
  }),
  'gaming.category.membership_evaluated': authContextBase.extend({
    categoryId: UuidSchema,
    actorId: UuidSchema,
    trigger: GameCategoryMembershipTriggerSchema,
    matchedCount: z.number().int().nonnegative(),
    relabeledCount: z.number().int().nonnegative().default(0),
    addedGameIds: z.array(UuidSchema),
    removedGameIds: z.array(UuidSchema),
  }),
  'gaming.category.membership_evaluation.failed': authContextBase.extend({
    categoryId: UuidSchema,
    actorId: UuidSchema,
    reason: z.string().max(500),
  }),
  'gaming.games.created': z.object({
    gameIds: z.array(UuidSchema).min(1).max(1000),
  }),
  'gaming.games.changed': z.object({
    gameIds: z.array(UuidSchema).max(1000),
    tagIds: z.array(UuidSchema).max(1000),
    providerIds: z.array(UuidSchema).max(1000),
  }),
  'gaming.ledger_game.projected': z.object({
    games: z
      .array(
        z.object({
          gameId: UuidSchema,
          providerId: UuidSchema,
          gameType: z.enum(GAME_TYPES),
          wagerProduct: WagerProductSchema.nullable().optional(),
          rtp: z.string().refine(isWagerRtp, 'decimal fraction in [0, 1]').nullable().optional(),
          version: z.number().int().nonnegative(),
        }),
      )
      .min(1)
      .max(1000),
  }),
  'gaming.tag.created': authContextBase
    .extend({ tagId: UuidSchema })
    .extend(GameTagSnapshotSchema.shape)
    .extend({ actorId: UuidSchema }),
  'gaming.tag.updated': authContextBase.extend({
    tagId: UuidSchema,
    actorId: UuidSchema,
    before: GameTagSnapshotSchema,
    after: GameTagSnapshotSchema,
  }),
  'gaming.tag.deleted': authContextBase.extend({
    tagId: UuidSchema,
    actorId: UuidSchema,
    before: GameTagSnapshotSchema,
    after: z.object({
      deleted: z.literal(true),
      affectedGameIds: z.array(UuidSchema),
    }),
  }),
  'gaming.game.updated': authContextBase.extend({
    gameId: UuidSchema,
    actorId: UuidSchema,
    before: z.object({
      slug: z.string(),
      name: z.string(),
      providerId: UuidSchema,
      aggregator: z.string(),
      thumbnailUrl: z.string().nullable(),
      customThumbnailUrl: z.string().nullable().default(null),
      isActive: z.boolean(),
      categoryIds: z.array(UuidSchema),
      tagIds: z.array(UuidSchema).default([]),
      metadata: z.unknown().nullable(),
    }),
    after: z.object({
      slug: z.string(),
      name: z.string(),
      providerId: UuidSchema,
      aggregator: z.string(),
      thumbnailUrl: z.string().nullable(),
      customThumbnailUrl: z.string().nullable().default(null),
      isActive: z.boolean(),
      categoryIds: z.array(UuidSchema),
      tagIds: z.array(UuidSchema).default([]),
      metadata: z.unknown().nullable(),
    }),
  }),
  'gaming.games.bulk_updated': z.discriminatedUnion('operation', [
    gameBulkEventBase.extend({
      operation: z.literal('set_active'),
      bulkOperationId: UuidSchema,
      isActive: z.boolean(),
      changedGameIds: z.array(UuidSchema),
      changedProviderIds: z.array(UuidSchema),
      affectedCategoryIds: z.array(UuidSchema).optional(),
    }),
    gameBulkEventBase.extend({
      operation: z.literal('add_tags'),
      tagIds: z.array(UuidSchema),
      addedLinks: GameAddedTagLinksSchema,
    }),
    gameBulkEventBase.extend({
      operation: z.literal('add_categories'),
      categoryIds: z.array(UuidSchema),
      addedLinks: GameAddedCategoryLinksSchema,
    }),
  ]),
  'gaming.games.reviewed': authContextBase.extend({
    actorId: UuidSchema,
    decision: GameReviewDecisionSchema,
    previousStatus: GameReviewStatusSchema.extract(['pending', 'declined']),
    gameIds: z.array(UuidSchema).min(1),
    bulkOperationId: UuidSchema.optional(),
  }),
  'gaming.games.auto_approved': z.object({
    providerId: UuidSchema,
    gameIds: z.array(UuidSchema).min(1).max(1000),
  }),
  'gaming.game.availability_changed': z.object({
    gameId: UuidSchema,
    before: z.object({ isUnavailable: z.boolean() }),
    after: z.object({ isUnavailable: z.boolean() }),
  }),

  'wallet.swap.completed': z.object({
    userId: UuidSchema,
    transactionId: UuidSchema,
    fromCurrency: CurrencyTickerSchema,
    fromAmount: MoneyAmountSchema,
    toCurrency: CurrencyTickerSchema,
    toAmount: MoneyAmountSchema,
  }),

  'wallet.turnover.cleared': z.object({
    userId: UuidSchema,
    clearedBy: UuidSchema,
    pivotCurrency: CurrencyTickerSchema,
    required: MoneyAmountSchema,
    progress: MoneyAmountSchema,
  }),
  'wallet.turnover.met': z.object({
    userId: UuidSchema,
    pivotCurrency: CurrencyTickerSchema,
    required: MoneyAmountSchema,
    progress: MoneyAmountSchema,
  }),

  'promo.bonus.granted': z.object({
    userId: UuidSchema,
    grantId: UuidSchema,
    currency: CurrencyTickerSchema,
    grantedAmount: MoneyAmountSchema,
    wageringRequired: MoneyAmountSchema,
    source: BonusGrantSourceSchema,
    offerId: UuidSchema.nullable(),
    rankBonusKind: z.enum(['daily', 'weekly', 'monthly']).optional(),
  }),
  'promo.bonus.activated': z.object({
    userId: UuidSchema,
    grantId: UuidSchema,
    currency: CurrencyTickerSchema,
    source: BonusGrantSourceSchema,
    expiresAt: TimestampSchema,
  }),
  'promo.bonus.completed': z.object({
    userId: UuidSchema,
    grantId: UuidSchema,
    currency: CurrencyTickerSchema,
    convertedAmount: MoneyAmountSchema,
  }),
  'promo.bonus.forfeited': z.object({
    userId: UuidSchema,
    grantId: UuidSchema,
    currency: CurrencyTickerSchema,
    forfeitedAmount: MoneyAmountSchema,
    reason: BonusForfeitReasonSchema,
    actorId: UuidSchema.nullable(),
  }),
  'promo.bonus.expired': z.object({
    userId: UuidSchema,
    grantId: UuidSchema,
    currency: CurrencyTickerSchema,
    forfeitedAmount: MoneyAmountSchema,
  }),
  'promo.streak.milestone.reached': z.object({
    userId: UuidSchema,
    day: z.number().int().positive(),
    amount: MoneyAmountSchema.optional(),
    currency: CurrencyTickerSchema.optional(),
    grantId: UuidSchema.nullable(),
  }),
  'promo.rakeback.claimable': z.object({
    userId: UuidSchema,
    amount: MoneyAmountSchema,
    currency: CurrencyTickerSchema,
  }),
  'promo.rank.reward.claimable': z.object({
    userId: UuidSchema,
    rewardId: UuidSchema,
    kind: z.enum(RANK_PERIODIC_REWARD_KINDS),
    periodKey: z.string(),
    currency: CurrencyTickerSchema,
    amount: MoneyAmountSchema,
  }),
  'promo.rank.reward.claimed': z.object({
    userId: UuidSchema,
    rewardId: UuidSchema,
    kind: z.enum(RANK_PERIODIC_REWARD_KINDS),
    currency: CurrencyTickerSchema,
    amount: MoneyAmountSchema,
    transactionId: UuidSchema,
    outcome: z.enum(RANK_PERIODIC_REWARD_STATUSES).exclude(['claimable']),
  }),
  'promo.rank.changed': z.object({
    userId: UuidSchema,
    tierId: UuidSchema,
    previousTierId: UuidSchema.nullable(),
    position: z.number().int().nonnegative(),
    tierName: z.string().min(1).optional(),
    currency: CurrencyTickerSchema.optional(),
    rakebackPercent: ContributionPercentSchema.optional(),
    levelUpBonus: MoneyAmountSchema.nullable().optional(),
    dailyBonus: MoneyAmountSchema.nullable().optional(),
    weeklyBonus: MoneyAmountSchema.nullable().optional(),
    monthlyBonus: MoneyAmountSchema.nullable().optional(),
    dailyBonusPercent: ContributionPercentSchema.nullable().optional(),
    weeklyBonusPercent: ContributionPercentSchema.nullable().optional(),
    monthlyBonusPercent: ContributionPercentSchema.nullable().optional(),
    periodicBasis: z.enum(RANK_PERIODIC_BASES).optional(),
  }),
  'promo.race.settled': z.object({
    raceId: UuidSchema,
    winners: z.array(
      z.object({
        userId: UuidSchema,
        rank: z.number().int().positive(),
        prizeAmount: MoneyAmountSchema,
        grantId: UuidSchema.nullable(),
      }),
    ),
    currency: CurrencyTickerSchema,
  }),
  'promo.race.won': z.object({
    userId: UuidSchema,
    raceId: UuidSchema,
    raceName: z.string(),
    position: z.number().int().positive(),
    amount: MoneyAmountSchema,
    currency: CurrencyTickerSchema,
  }),
  'promo.rank-challenge.won': z.object({
    userId: UuidSchema,
    tierId: UuidSchema,
    tierKey: z.string(),
    tierName: z.string(),
    cashAmount: MoneyAmountSchema.nullable(),
    physicalItem: z.string().nullable(),
    currency: CurrencyTickerSchema,
  }),

  'chat.message.sent': z.object({
    messageId: UuidSchema,
    roomId: UuidSchema.nullable(),
    userId: UuidSchema,
  }),

  'chat.system_message.upserted': z.object({
    messageId: UuidSchema,
    roomId: UuidSchema.nullable(),
    actorId: UuidSchema,
    username: z.string(),
    metadata: CommandMetadataSchema,
    version: z.number().int().positive(),
  }),

  'chat.context_room.command_issued': z.discriminatedUnion('op', [
    EnsureChatContextRoomInputSchema.extend({ op: z.literal('ensure'), roomId: UuidSchema }),
    z.object({ op: z.literal('close'), ref: ChatContextRefSchema }),
    z.object({
      op: z.literal('post_system_event'),
      ref: ChatContextRefSchema,
      messageId: UuidSchema,
      metadata: SystemEventMetadataSchema,
    }),
  ]),

  'chat.user.blocked': authContextBase.extend({
    blockerId: UuidSchema,
    actorPlayerId: UuidSchema.nullable(),
    blockedId: UuidSchema,
    playerId: UuidSchema.nullable(),
  }),
  'chat.user.unblocked': authContextBase.extend({
    blockerId: UuidSchema,
    actorPlayerId: UuidSchema.nullable(),
    blockedId: UuidSchema,
    playerId: UuidSchema.nullable(),
  }),
  'chat.user.ignored': authContextBase.extend({
    ignorerId: UuidSchema,
    actorPlayerId: UuidSchema.nullable(),
    ignoredId: UuidSchema,
    playerId: UuidSchema.nullable(),
  }),
  'chat.user.unignored': authContextBase.extend({
    ignorerId: UuidSchema,
    actorPlayerId: UuidSchema.nullable(),
    ignoredId: UuidSchema,
    playerId: UuidSchema.nullable(),
  }),

  'chat.room.created': authContextBase.extend({
    roomId: UuidSchema,
    name: z.string(),
    slug: z.string(),
    category: z.string().nullable(),
    actorId: UuidSchema.optional(),
  }),
  'chat.room.deleted': authContextBase.extend({
    roomId: UuidSchema,
    actorId: UuidSchema.optional(),
    before: z.object({ name: z.string(), slug: z.string(), category: z.string().nullable() }),
  }),
  'chat.room.updated': authContextBase.extend({
    roomId: UuidSchema,
    actorId: UuidSchema.optional(),
    before: z.object({ name: z.string(), slug: z.string(), category: z.string().nullable() }),
    after: z.object({ name: z.string(), slug: z.string(), category: z.string().nullable() }),
  }),

  'chat.private_room.created': authContextBase.extend({
    roomId: UuidSchema,
    creatorId: UuidSchema,
    playerId: UuidSchema.nullable(),
  }),
  'chat.private_room.deleted': authContextBase.extend({
    roomId: UuidSchema,
    creatorId: UuidSchema,
    playerId: UuidSchema.nullable(),
    before: z.object({ name: z.string(), slug: z.string(), category: z.string().nullable() }),
    after: z.object({ deletedAt: z.string() }),
  }),
  'chat.room.member.joined': authContextBase.extend({
    roomId: UuidSchema,
    userId: UuidSchema,
    playerId: UuidSchema.nullable(),
    adminId: UuidSchema.optional(),
    auditRecorded: z.literal(true).optional(),
  }),
  'chat.room.invite.sent': authContextBase.extend({
    inviteId: UuidSchema,
    roomId: UuidSchema,
    inviterId: UuidSchema,
    inviteeId: UuidSchema,
    inviterUsername: z.string(),
    roomName: z.string(),
    playerId: UuidSchema.nullable(),
  }),
  'chat.room.invite.withheld': authContextBase.extend({
    inviteId: UuidSchema,
    roomId: UuidSchema,
    inviterId: UuidSchema,
    inviteeId: UuidSchema,
    playerId: UuidSchema.nullable(),
  }),
  'chat.room.invite.accepted': authContextBase.extend({
    inviteId: UuidSchema,
    roomId: UuidSchema,
    inviterId: UuidSchema,
    inviteeId: UuidSchema,
    playerId: UuidSchema.nullable(),
  }),
  'chat.room.invite.declined': authContextBase.extend({
    inviteId: UuidSchema,
    roomId: UuidSchema,
    inviterId: UuidSchema,
    inviteeId: UuidSchema,
    playerId: UuidSchema.nullable(),
  }),
  'chat.room.invite.expired': authContextBase.extend({
    inviteId: UuidSchema,
    roomId: UuidSchema,
    inviterId: UuidSchema,
    inviteeId: UuidSchema,
    actorId: UuidSchema.optional(),
    actorPlayerId: UuidSchema.nullable().optional(),
  }),
  'chat.room.member.left': authContextBase.extend({
    roomId: UuidSchema,
    userId: UuidSchema,
    playerId: UuidSchema.nullable(),
  }),
  'chat.room.member.kicked': authContextBase.extend({
    roomId: UuidSchema,
    userId: UuidSchema,
    kickedBy: UuidSchema,
    playerId: UuidSchema.nullable(),
  }),
  'chat.room.member.removed': authContextBase.extend({
    roomId: UuidSchema,
    userId: UuidSchema,
    removedBy: UuidSchema,
  }),
  'chat.room.member.role-changed': authContextBase.extend({
    roomId: UuidSchema,
    userId: UuidSchema,
    changedBy: UuidSchema,
    role: z.enum(['member', 'moderator']),
    previousRole: z.enum(['member', 'moderator']),
    playerId: UuidSchema.nullable(),
  }),
  'chat.room.member.banned': authContextBase.extend({
    roomId: UuidSchema,
    userId: UuidSchema,
    bannedBy: UuidSchema,
    playerId: UuidSchema.nullable(),
    reason: z.string().optional(),
    expiresAt: z.iso.datetime().nullable().optional(),
    replaced: z
      .object({ banId: UuidSchema, expiresAt: z.iso.datetime().nullable() })
      .nullable()
      .optional(),
  }),

  'chat.room.ownership.transferred': authContextBase.extend({
    roomId: UuidSchema,
    roomName: z.string(),
    previousOwnerId: UuidSchema,
    newOwnerId: UuidSchema,
    reason: z.literal('account-closed'),
  }),
  'chat.room.scheduled_for_deletion': authContextBase.extend({
    roomId: UuidSchema,
    roomName: z.string(),
    previousOwnerId: UuidSchema,
    memberIds: z.array(UuidSchema),
    scheduledDeletionAt: TimestampSchema,
  }),
  'chat.room.deletion.cancelled': authContextBase.extend({
    roomId: UuidSchema,
    roomName: z.string(),
    ownerId: UuidSchema,
    memberIds: z.array(UuidSchema),
  }),
  'chat.private_room.purged': authContextBase.extend({
    roomId: UuidSchema,
    messageCount: z.number().int(),
  }),

  'compliance.geo-rule.added': authContextBase.extend({
    countryCode: CountryCodeSchema,
    action: GeoRuleActionSchema,
    actorId: UuidSchema.optional(),
  }),

  'compliance.geo.access_blocked': authContextBase.extend({
    countryCode: CountryCodeSchema.nullable(),
    reason: z.string(),
  }),
  'compliance.geo.access_redirected': authContextBase.extend({
    countryCode: CountryCodeSchema,
    redirectUrl: z.string(),
  }),

  'compliance.game-geo-rule.upserted': authContextBase.extend({
    ruleId: UuidSchema,
    gameId: UuidSchema,
    countryCode: CountryCodeSchema,
    reason: NonEmptyReasonSchema,
    before: gameGeoRuleEventState.nullable(),
    after: gameGeoRuleEventState,
    actorId: UuidSchema.nullable(),
    auditRecorded: z.literal(true).optional(),
  }),

  'compliance.game-geo-rule.deleted': authContextBase.extend({
    ruleId: UuidSchema,
    gameId: UuidSchema,
    countryCode: CountryCodeSchema,
    reason: NonEmptyReasonSchema,
    before: gameGeoRuleEventState,
    after: z.null(),
    actorId: UuidSchema.nullable(),
    auditRecorded: z.literal(true).optional(),
  }),

  'compliance.game-geo-rules.bulk_updated': gameBulkEventBase.extend({
    operation: z.enum(['restrict', 'unrestrict']),
    countryCode: CountryCodeSchema,
    reason: NonEmptyReasonSchema,
    changedGameIds: z.array(UuidSchema),
  }),

  'compliance.provider-geo-rule.upserted': authContextBase.extend({
    ruleId: UuidSchema,
    providerId: UuidSchema,
    countryCode: CountryCodeSchema,
    reason: NonEmptyReasonSchema,
    before: providerGeoRuleEventState.nullable(),
    after: providerGeoRuleEventState,
    actorId: UuidSchema,
  }),

  'compliance.provider-geo-rule.deleted': authContextBase.extend({
    ruleId: UuidSchema,
    providerId: UuidSchema,
    countryCode: CountryCodeSchema,
    reason: NonEmptyReasonSchema,
    before: providerGeoRuleEventState,
    after: z.null(),
    actorId: UuidSchema,
  }),

  'compliance.limit.upserted': authContextBase.extend({
    userId: UuidSchema,
    playerId: UuidSchema.nullable(),
    limitId: UuidSchema,
  }),
  'compliance.limit.removed': authContextBase.extend({
    userId: UuidSchema,
    playerId: UuidSchema.nullable(),
    limitId: UuidSchema,
  }),

  'rg.limit.set': authContextBase.extend({
    userId: UuidSchema,
    playerId: UuidSchema.nullable(),
    actorId: UuidSchema,
    limitId: UuidSchema,
    type: LimitTypeSchema,
    period: LimitPeriodSchema,
    amount: MoneyAmountSchema.nullable(),
    minutes: z.number().int().nullable(),
    previousAmount: MoneyAmountSchema.nullable(),
    previousMinutes: z.number().int().nullable(),
    currency: CurrencyTickerSchema.nullable(),
    previousCurrency: CurrencyTickerSchema.nullable().default(null),
    initiatedBy: RgInitiatorSchema,
    reason: z.string().nullable(),
  }),
  'rg.limit.change_requested': limitChangeBase.extend({
    actorId: UuidSchema,
    effectiveAt: TimestampSchema,
    expiresAt: TimestampSchema,
    initiatedBy: RgInitiatorSchema,
  }),
  'rg.limit.change_confirmed': limitChangeBase.extend({
    actorId: UuidSchema,
    initiatedBy: RgInitiatorSchema,
  }),
  'rg.limit.change_cancelled': limitChangeBase.extend({
    actorId: UuidSchema,
    initiatedBy: RgInitiatorSchema,
  }),
  'rg.limit.change_expired': limitChangeBase.extend({ expiresAt: TimestampSchema }),
  'rg.cooling_off.activated': actorReasonBase
    .extend({
      userId: UuidSchema,
      playerId: UuidSchema.nullable(),
      exclusionId: UuidSchema,
      expiresAt: TimestampSchema,
      initiatedBy: RgInitiatorSchema,
    })
    .extend(authContextBase.shape),
  'rg.self_exclusion.activated': actorReasonBase
    .extend({
      userId: UuidSchema,
      playerId: UuidSchema.nullable(),
      exclusionId: UuidSchema,
      isPermanent: z.boolean(),
      durationMonths: z.number().int().nullable(),
      expiresAt: TimestampSchema.nullable(),
      initiatedBy: RgInitiatorSchema,
    })
    .extend(authContextBase.shape),
  'rg.self_exclusion.lifted': actorReasonBase
    .extend({
      userId: UuidSchema,
      playerId: UuidSchema.nullable(),
      exclusionId: UuidSchema,
      kind: ExclusionKindSchema,
    })
    .extend(authContextBase.shape),
  'rg.cooling_off.lifted': actorReasonBase
    .extend({ userId: UuidSchema, playerId: UuidSchema.nullable(), exclusionId: UuidSchema })
    .extend(authContextBase.shape),
  'rg.cooling_off.expired': authContextBase.extend({
    userId: UuidSchema,
    playerId: UuidSchema.nullable(),
    exclusionId: UuidSchema,
    expiresAt: TimestampSchema,
  }),
  'rg.exclusion.login_blocked': authContextBase.extend({
    userId: UuidSchema,
    playerId: UuidSchema.nullable(),
  }),

  'compliance.kyc.updated': KycStatusUpdatedSchema,

  'compliance.kyc.submitted': authContextBase.extend({
    userId: UuidSchema,
    playerId: UuidSchema.nullable(),
    referenceId: z.string(),
    provider: z.string(),
    tier: KycTierSchema.default('basic'),
  }),

  'compliance.kyc.reverify_required': z.object({
    userId: UuidSchema,
    playerId: UuidSchema.nullable(),
    reason: z.string(),
    tier: KycTierSchema.default('basic'),
  }),

  'compliance.kyc.high_risk_signal_detected': z.object({
    userId: UuidSchema,
    playerId: UuidSchema.nullable(),
    referenceId: z.string(),
    vpnOrTorDetected: z.boolean(),
    dataCenterIpDetected: z.boolean(),
    duplicateDeviceDetected: z.boolean(),
    highRiskCountryDetected: z.boolean(),
    tier: KycTierSchema.default('basic'),
  }),

  'compliance.kyc.underage_detected': z.object({
    userId: UuidSchema,
    playerId: UuidSchema.nullable(),
    referenceId: z.string(),
    tier: KycTierSchema,
  }),

  'compliance.kyc.dob_mismatch_detected': z.object({
    userId: UuidSchema,
    playerId: UuidSchema.nullable(),
    referenceId: z.string(),
    tier: KycTierSchema,
  }),

  'notifications.created': z.object({ notificationId: UuidSchema, userId: UuidSchema }),

  'cms.page.published': authContextBase.extend({ pageId: UuidSchema, slug: z.string() }),
  'cms.page.created': cmsPageEventBase,
  'cms.page.updated': cmsPageEventBase,
  'cms.page.deleted': cmsPageEventBase,
  'cms.banner.configuration.created': cmsBannerConfigurationEventBase,
  'cms.banner.configuration.deleted': cmsBannerConfigurationEventBase.extend({
    droppedImageUrls: droppedImageUrlsSchema,
  }),
  'cms.banner.configuration.set_default': cmsBannerConfigurationEventBase,
  'cms.banner.configuration.unset_default': z
    .object({
      placement: z.string(),
      previousBannerConfigurationId: UuidSchema.nullable(),
      actorId: UuidSchema,
    })
    .extend(authContextBase.shape),
  'cms.banner.image.set': cmsBannerImageEventBase.extend({
    droppedImageUrls: droppedImageUrlsSchema,
  }),
  'cms.banner.image.deleted': cmsBannerImageEventBase.extend({
    droppedImageUrls: droppedImageUrlsSchema,
  }),
  'cms.banner.schedule.created': cmsBannerScheduleEventBase,
  'cms.banner.schedule.updated': cmsBannerScheduleUpdatedEvent,

  'iam.invitation.created': authContextBase.extend({
    email: z.email(),
    roleId: UuidSchema,
    invitationId: UuidSchema,
    actorId: UuidSchema,
  }),

  'iam.invitation.accepted': authContextBase.extend({
    email: z.email(),
    roleId: UuidSchema,
    invitationId: UuidSchema,
    userId: UuidSchema,
  }),

  'iam.role.created': iamRoleEventBase.extend({
    name: z.string(),
  }),
  'iam.role.updated': iamRoleEventBase.extend({
    name: z.string().optional(),
  }),
  'iam.role.deleted': iamRoleEventBase,
  'iam.role.permissions.changed': iamRoleEventBase.extend({
    before: permissionLevelEntries,
    after: permissionLevelEntries,
  }),
  'iam.role.assigned': iamRoleEventBase.extend({ userId: UuidSchema }),
  'iam.role.revoked': iamRoleEventBase.extend({ userId: UuidSchema }),

  'tag.created': z.object({ key: TagKeySchema, isSticky: z.boolean(), actorId: UuidSchema }),
  'tag.deleted': z.object({ key: TagKeySchema, actorId: UuidSchema }),
  'tag.player.assigned': tagPlayerEventBase,
  'tag.player.removed': tagPlayerEventBase,
  'tag.withdrawal.screened': z.object({
    userId: UuidSchema,
    transactionId: UuidSchema,
    reviewRequired: z.boolean().optional(),
  }),
  'tag.rule.upserted': authContextBase.extend({
    tagKey: TagKeySchema,
    actorId: UuidSchema,
    after: z.record(z.string(), z.unknown()),
  }),

  'chat.user.mentioned': z.object({
    mentionedUserId: UuidSchema,
    byUserId: UuidSchema,
    byUsername: z.string().min(1).optional(),
    roomId: UuidSchema.nullable(),
    messageId: z.string(),
  }),
  'player.level.changed': z.object({
    userId: UuidSchema,
    playerId: UuidSchema.nullable(),
    previousLevel: z.number().int(),
    newLevel: z.number().int(),
    actorId: UuidSchema,
  }),
  'player.login_blocked': authContextBase.extend({
    userId: UuidSchema,
    playerId: UuidSchema.nullable(),
    status: PlayerStatusSchema,
  }),
  'player.account.closed': authContextBase.extend({
    playerId: UuidSchema,
    userId: UuidSchema,
    actorId: UuidSchema,
  }),
  'player.account.reopened': authContextBase.extend({
    playerId: UuidSchema,
    userId: UuidSchema,
    actorId: UuidSchema,
  }),
  'player.status.changed': authContextBase.extend({
    playerId: UuidSchema,
    userId: UuidSchema,
    actorId: UuidSchema.nullable(),
    previousStatus: PlayerStatusSchema,
    newStatus: PlayerStatusSchema,
  }),
  'player.account_manager.changed': authContextBase.extend({
    playerId: UuidSchema,
    userId: UuidSchema,
    previousAccountManagerId: UuidSchema.nullable(),
    accountManagerId: UuidSchema.nullable(),
    actorId: UuidSchema,
  }),

  'social.friend_request.sent': authContextBase.extend({
    friendshipId: UuidSchema,
    requesterId: UuidSchema,
    addresseeId: UuidSchema,
    requesterUsername: z.string(),
  }),
  'social.friend_request.accepted': authContextBase.extend({
    friendshipId: UuidSchema,
    requesterId: UuidSchema,
    addresseeId: UuidSchema,
    accepterId: UuidSchema,
    accepterUsername: z.string(),
  }),
  'social.friendship.removed': authContextBase.extend({
    friendshipId: UuidSchema,
    actorId: UuidSchema,
    actorPlayerId: UuidSchema.nullable(),
    otherUserId: UuidSchema,
    reason: z.enum(['removed_by_player', 'blocked']),
  }),
  'social.friend_request.declined': authContextBase.extend({
    friendshipId: UuidSchema,
    requesterId: UuidSchema,
    addresseeId: UuidSchema,
  }),
  'social.friend_request.cancelled': authContextBase.extend({
    friendshipId: UuidSchema,
    requesterId: UuidSchema,
    addresseeId: UuidSchema,
  }),

  'support_chat.customer.linked': z.object({ userId: UuidSchema, playerId: UuidSchema }),
} as const;

export type DomainEventName = keyof typeof domainEventSchemas;
export type DomainEventPayload<K extends DomainEventName> = z.infer<(typeof domainEventSchemas)[K]>;

export const domainEventVersions: Partial<Record<DomainEventName, number>> = {
  'compliance.kyc.updated': 6,
  'compliance.kyc.submitted': 2,
  'compliance.kyc.reverify_required': 2,
  'compliance.kyc.high_risk_signal_detected': 2,
  'identity.session.revoked': 2,
  'identity.sessions.revoked_all': 2,
  'identity.2fa.enabled': 2,
  'identity.2fa.disabled': 3,
  'identity.2fa.backup_codes_regenerated': 2,
  'wallet.deposit.completed': 2,
  'wallet.withdrawal.completed': 2,
  'wallet.withdrawal.requested': 2,
  'wallet.withdrawal.approved': 2,
  'wallet.withdrawal.rejected': 2,
  'wallet.withdrawal.failed': 3,
  'wallet.manual_adjustment.created': 2,
  'wallet.balance.changed': 2,
  'rg.limit.set': 5,
  'rg.cooling_off.activated': 2,
  'rg.self_exclusion.activated': 4,
  'gaming.category.games_reordered': 3,
  'compliance.game-geo-rule.upserted': 2,
  'compliance.game-geo-rule.deleted': 2,
  'player.status.changed': 2,
};

export function getEventVersion(event: string): number {
  return domainEventVersions[event as DomainEventName] ?? 1;
}

export const DOMAIN_EVENT_CATALOG = Object.keys(domainEventSchemas) as DomainEventName[];

export function eventCatalog(): ReadonlyArray<{ topic: DomainEventName; version: number }> {
  return DOMAIN_EVENT_CATALOG.map((topic) => ({
    topic,
    version: getEventVersion(topic),
  }));
}
