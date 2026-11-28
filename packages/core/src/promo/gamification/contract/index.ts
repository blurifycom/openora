import { oc } from '@orpc/contract';
import * as z from 'zod';
import { PageQuerySchema, paginated } from '@openora/core/contracts/kit';
import {
  ContributionPercentSchema,
  CurrencyTickerSchema,
  MoneyAmountSchema,
  RAKEBACK_BASES,
  RANK_PERIODIC_BASES,
  RANK_PERIODIC_REWARD_KINDS,
  RANK_PERIODIC_REWARD_STATUSES,
  TimestampSchema,
  UuidSchema,
  WAGER_PRODUCTS,
  WagerProductSchema,
  type WagerProduct,
} from '@openora/core/contracts';

export const RankTierSchema = z.object({
  id: UuidSchema,
  key: z.string().min(1),
  name: z.string().min(1),
  position: z.number().int().nonnegative(),
  wagerThreshold: MoneyAmountSchema,
  rakebackPercent: ContributionPercentSchema,
  dailyBonus: MoneyAmountSchema.nullable(),
  weeklyBonus: MoneyAmountSchema.nullable(),
  monthlyBonus: MoneyAmountSchema.nullable(),
  levelUpBonus: MoneyAmountSchema.nullable(),
  dailyBonusPercent: ContributionPercentSchema.nullable(),
  weeklyBonusPercent: ContributionPercentSchema.nullable(),
  monthlyBonusPercent: ContributionPercentSchema.nullable(),
});

export type RankTier = z.infer<typeof RankTierSchema>;

const RankPeriodicBasisSchema = z.enum(RANK_PERIODIC_BASES);

export const RANK_PERIODIC_PAYOUT_MODES = ['bonus', 'claim'] as const;
export const RankPeriodicPayoutModeSchema = z.enum(RANK_PERIODIC_PAYOUT_MODES);
export type RankPeriodicPayoutMode = z.infer<typeof RankPeriodicPayoutModeSchema>;

export const RankPeriodicPayoutSchema = z.object({
  daily: RankPeriodicPayoutModeSchema,
  weekly: RankPeriodicPayoutModeSchema,
  monthly: RankPeriodicPayoutModeSchema,
});
export type RankPeriodicPayout = z.infer<typeof RankPeriodicPayoutSchema>;

export const PlayerRankSchema = z.object({
  currency: CurrencyTickerSchema,
  periodicBasis: RankPeriodicBasisSchema,
  periodicPayout: RankPeriodicPayoutSchema,
  lifetimeWagered: MoneyAmountSchema,
  tierId: UuidSchema.nullable(),
  tiers: z.array(RankTierSchema),
});

export type PlayerRank = z.infer<typeof PlayerRankSchema>;

export const RankLadderSchema = z.object({
  currency: CurrencyTickerSchema,
  periodicBasis: RankPeriodicBasisSchema,
  periodicPayout: RankPeriodicPayoutSchema,
  tiers: z.array(RankTierSchema),
});

export type RankLadder = z.infer<typeof RankLadderSchema>;

const MAX_TIERS = 50;

const SubmittedTierSchema = RankTierSchema.omit({ id: true, position: true }).extend({
  id: UuidSchema.optional(),
  dailyBonusPercent: ContributionPercentSchema.nullable().optional(),
  weeklyBonusPercent: ContributionPercentSchema.nullable().optional(),
  monthlyBonusPercent: ContributionPercentSchema.nullable().optional(),
});

export type SubmittedRankTier = z.infer<typeof SubmittedTierSchema>;

export const SetRankLadderInputSchema = z.object({
  currency: CurrencyTickerSchema,
  tiers: z
    .array(SubmittedTierSchema)
    .min(1)
    .max(MAX_TIERS)
    .refine(
      (tiers) => new Set(tiers.map((tier) => tier.key)).size === tiers.length,
      'two tiers share a key',
    )
    .refine((tiers) => {
      const ids = tiers.flatMap((tier) => (tier.id === undefined ? [] : [tier.id]));
      return new Set(ids).size === ids.length;
    }, 'two entries target the same tier')
    .refine(
      (tiers) =>
        tiers.every((tier) => BONUS_FIELDS.every((field) => isAbsentOrPositive(tier[field]))),
      'a bonus amount is either absent or above zero',
    )
    .refine(
      (tiers) =>
        tiers.every((tier) =>
          PERCENT_FIELDS.every((field) => isAbsentOrPositive(tier[field] ?? null)),
        ),
      'a bonus percent is either absent or above zero',
    )
    .refine(
      (tiers) => !tiers.some(paysOverHouseEdge),
      'rakeback and the bonus percents of a tier add up to at most 100',
    ),
});

export type SetRankLadderInput = z.infer<typeof SetRankLadderInputSchema>;

const BONUS_FIELDS = ['dailyBonus', 'weeklyBonus', 'monthlyBonus', 'levelUpBonus'] as const;
const PERCENT_FIELDS = ['dailyBonusPercent', 'weeklyBonusPercent', 'monthlyBonusPercent'] as const;

const isAbsentOrPositive = (amount: string | null) => amount === null || /[1-9]/.test(amount);

const hundredths = (percent: string | null | undefined) => {
  const [whole = '0', fraction = ''] = (percent ?? '0').split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
};

export const paysOverHouseEdge = (tier: {
  rakebackPercent: string;
  dailyBonusPercent?: string | null | undefined;
  weeklyBonusPercent?: string | null | undefined;
  monthlyBonusPercent?: string | null | undefined;
}) =>
  hundredths(tier.rakebackPercent) +
    PERCENT_FIELDS.reduce((sum, field) => sum + hundredths(tier[field]), 0) >
  100 * 100;

export const RANK_PAYOUT_KINDS = ['levelUp', 'daily', 'weekly', 'monthly'] as const;
export const RankPayoutKindSchema = z.enum(RANK_PAYOUT_KINDS);
export type RankPayoutKind = z.infer<typeof RankPayoutKindSchema>;

const MAX_EXPIRY_DAYS = 365;

export const RankRewardTermsSchema = z.object({
  wageringMultiplier: MoneyAmountSchema.refine(isAbsentOrPositive, 'must be above zero'),
  expiryDays: z.number().int().positive().max(MAX_EXPIRY_DAYS),
  maxBet: MoneyAmountSchema.refine(isAbsentOrPositive, 'must be above zero').nullish(),
  maxWinMultiplier: MoneyAmountSchema.refine(isAbsentOrPositive, 'must be above zero').nullish(),
});

export type RankRewardTerms = z.infer<typeof RankRewardTermsSchema>;

const RankLevelUpRewardTermsSchema = RankRewardTermsSchema.extend({
  payout: z.literal('bonus').optional(),
});

export const RankPeriodicRewardTermsSchema = z.union([
  RankRewardTermsSchema.extend({ payout: z.literal('bonus').optional() }),
  z.object({ payout: z.literal('claim') }),
]);
export type RankPeriodicRewardTerms = z.infer<typeof RankPeriodicRewardTermsSchema>;

export const RankPayoutAnchorsSchema = z.object({
  dailyHour: z.number().int().min(0).max(23),
  weeklyDay: z.number().int().min(1).max(7),
  monthlyDay: z.number().int().min(1).max(28),
});

export type RankPayoutAnchors = z.infer<typeof RankPayoutAnchorsSchema>;

export const DEFAULT_PAYOUT_ANCHORS: RankPayoutAnchors = {
  dailyHour: 0,
  weeklyDay: 1,
  monthlyDay: 1,
};

export const DEFAULT_RANK_PERK_PRODUCTS = [
  'casino',
  'live-casino',
  'pvp',
] as const satisfies readonly WagerProduct[];

const RankPerkProductsSchema = z.array(z.enum(WAGER_PRODUCTS)).max(WAGER_PRODUCTS.length);

const EligibleProductsInputSchema = z
  .array(WagerProductSchema)
  .min(1, 'select at least one product')
  .refine((products) => new Set(products).size === products.length, 'products must not repeat');

export const RankConfigSchema = z.object({
  payoutCurrency: CurrencyTickerSchema.nullish(),
  payInPlayerCurrency: z.boolean().prefault(false),
  periodicRequiresActivity: z.boolean().prefault(true),
  periodicMinimumWager: MoneyAmountSchema.refine(
    isAbsentOrPositive,
    'must be above zero',
  ).nullish(),
  eligibleProducts: z.array(z.string().trim().min(1).max(64)).max(50),
  rakebackEligibleProducts: RankPerkProductsSchema,
  rankChallengeEligibleProducts: RankPerkProductsSchema,
  rewards: z
    .object({
      levelUp: RankLevelUpRewardTermsSchema,
      daily: RankPeriodicRewardTermsSchema,
      weekly: RankPeriodicRewardTermsSchema,
      monthly: RankPeriodicRewardTermsSchema,
    })
    .partial(),
  payoutAnchors: RankPayoutAnchorsSchema.prefault(DEFAULT_PAYOUT_ANCHORS),
});

export type RankConfig = z.infer<typeof RankConfigSchema>;

export const SetRankConfigInputSchema = RankConfigSchema.extend({
  eligibleProducts: EligibleProductsInputSchema,
  rakebackEligibleProducts: EligibleProductsInputSchema.optional(),
  rankChallengeEligibleProducts: EligibleProductsInputSchema.optional(),
});
export type SetRankConfigInput = z.infer<typeof SetRankConfigInputSchema>;
export type RankConfigInput = z.input<typeof SetRankConfigInputSchema>;

export const STREAK_CURRENCY = 'USD';
export const STREAK_MAX_DAY = 35;
const STREAK_MAX_ROLLOVER_MULTIPLIER = 1000;
const STREAK_MAX_CLAIM_EXPIRY_DAYS = 365;

export const STREAK_RAKEBACK_MODES = ['unranked', 'ranked'] as const;
export const StreakRakebackModeSchema = z.enum(STREAK_RAKEBACK_MODES);
export type StreakRakebackMode = z.infer<typeof StreakRakebackModeSchema>;

export const STREAK_FIXED_REWARD_STATES = ['locked', 'claimable', 'claimed', 'expired'] as const;
export const StreakFixedRewardStateSchema = z.enum(STREAK_FIXED_REWARD_STATES);
export type StreakFixedRewardState = z.infer<typeof StreakFixedRewardStateSchema>;

export const STREAK_GRANT_OUTCOMES = ['granted', 'restricted', 'reversed', 'expired'] as const;
export type StreakGrantOutcome = (typeof STREAK_GRANT_OUTCOMES)[number];

const isRolloverWithinLimit = (value: string) => {
  const [whole = '0', fraction = ''] = value.split('.');
  if (!/^\d+$/.test(whole)) {
    return true;
  }
  const wholePart = BigInt(whole);
  const limit = BigInt(STREAK_MAX_ROLLOVER_MULTIPLIER);
  return wholePart < limit || (wholePart === limit && !/[1-9]/.test(fraction));
};

const StreakDaySchema = z.number().int().min(1).max(STREAK_MAX_DAY);

export const StreakRakebackMilestoneSchema = z.object({
  day: StreakDaySchema,
  unrankedRatePercent: ContributionPercentSchema,
  rankedUpliftPercent: ContributionPercentSchema,
});
export type StreakRakebackMilestone = z.infer<typeof StreakRakebackMilestoneSchema>;

export const StreakFixedRewardSchema = z.object({
  day: StreakDaySchema,
  amount: MoneyAmountSchema.refine(isAbsentOrPositive, 'must be above zero'),
  rolloverMultiplier: MoneyAmountSchema.refine(isAbsentOrPositive, 'must be above zero').refine(
    isRolloverWithinLimit,
    `must not exceed ${STREAK_MAX_ROLLOVER_MULTIPLIER}`,
  ),
  claimExpiryDays: z.number().int().min(1).max(STREAK_MAX_CLAIM_EXPIRY_DAYS),
  maxBet: MoneyAmountSchema.refine(isAbsentOrPositive, 'must be above zero').nullish(),
});
export type StreakFixedReward = z.infer<typeof StreakFixedRewardSchema>;

const dayOrdered = <Item extends z.ZodType<{ day: number }>>(item: Item) =>
  z
    .array(item)
    .max(STREAK_MAX_DAY)
    .superRefine((rows, ctx) => {
      rows.forEach((row, index) => {
        const previous = rows[index - 1];
        if (previous === undefined || row.day > previous.day) {
          return;
        }
        ctx.addIssue({
          code: 'custom',
          message: row.day === previous.day ? 'two entries share a day' : 'days must ascend',
          path: [index, 'day'],
        });
      });
    });

export const StreakConfigSchema = z.object({
  enabled: z.boolean(),
  dailyMinWager: MoneyAmountSchema,
  eligibleProducts: z.array(z.string().trim().min(1).max(64)).max(50),
  rakebackMilestones: dayOrdered(StreakRakebackMilestoneSchema),
  fixedRewards: dayOrdered(StreakFixedRewardSchema),
});
export type StreakConfig = z.infer<typeof StreakConfigSchema>;

export const SetStreakConfigInputSchema = StreakConfigSchema.extend({
  dailyMinWager: MoneyAmountSchema.refine(isAbsentOrPositive, 'must be above zero'),
  eligibleProducts: EligibleProductsInputSchema,
});
export type StreakConfigInput = z.input<typeof SetStreakConfigInputSchema>;

export const StreakActiveRateSchema = z.object({
  mode: StreakRakebackModeSchema,
  percent: ContributionPercentSchema,
});
export type StreakActiveRate = z.infer<typeof StreakActiveRateSchema>;

export const StreakNextMilestoneSchema = z.object({
  day: StreakDaySchema,
  rakeback: StreakRakebackMilestoneSchema.nullable(),
  fixedReward: StreakFixedRewardSchema.nullable(),
});
export type StreakNextMilestone = z.infer<typeof StreakNextMilestoneSchema>;

export const PlayerStreakFixedRewardSchema = StreakFixedRewardSchema.extend({
  state: StreakFixedRewardStateSchema,
  grantId: UuidSchema.nullable(),
  unlockedAt: TimestampSchema.nullable(),
  expiresAt: TimestampSchema.nullable(),
});
export type PlayerStreakFixedReward = z.infer<typeof PlayerStreakFixedRewardSchema>;

export const PlayerStreakSchema = z.object({
  enabled: z.boolean(),
  current: z.number().int().nonnegative(),
  best: z.number().int().nonnegative(),
  todayWagered: MoneyAmountSchema,
  dailyMinWager: MoneyAmountSchema,
  currency: CurrencyTickerSchema,
  isRanked: z.boolean(),
  activeRate: StreakActiveRateSchema.nullable(),
  nextMilestone: StreakNextMilestoneSchema.nullable(),
  rakebackMilestones: z.array(StreakRakebackMilestoneSchema),
  fixedRewards: z.array(PlayerStreakFixedRewardSchema),
});
export type PlayerStreak = z.infer<typeof PlayerStreakSchema>;

export const StreakForfeitReasonSchema = z.enum(['self_exclusion', 'cooling_off']);
export type StreakForfeitReason = z.infer<typeof StreakForfeitReasonSchema>;

export const ClaimStreakMilestoneInputSchema = z.object({ milestoneGrantId: UuidSchema });

export const StreakClaimResultSchema = z.object({
  outcome: z.enum(['granted', 'restricted']),
});
export type StreakClaimResult = z.infer<typeof StreakClaimResultSchema>;

export const StreakLeaderboardEntrySchema = z.object({
  userId: UuidSchema,
  username: z.string(),
  streak: z.number().int().nonnegative(),
});
export type StreakLeaderboardEntry = z.infer<typeof StreakLeaderboardEntrySchema>;

export const StreakLeaderboardSchema = z.object({
  top: z.array(StreakLeaderboardEntrySchema).max(5),
  ownPosition: z.number().int().positive().nullable(),
});
export type StreakLeaderboard = z.infer<typeof StreakLeaderboardSchema>;

const MAX_LOOKUP_IDS = 100;

export const RankLookupInputSchema = z.object({
  userIds: z.array(UuidSchema).min(1).max(MAX_LOOKUP_IDS),
});
export type RankLookupInput = z.infer<typeof RankLookupInputSchema>;

export const RankLookupEntrySchema = z.object({
  userId: UuidSchema,
  tierKey: z.string().nullable(),
  tierName: z.string().nullable(),
});
export type RankLookupEntry = z.infer<typeof RankLookupEntrySchema>;

export const RankPlayersEntrySchema = z.object({
  tierId: UuidSchema,
  players: z.number().int().nonnegative(),
});
export type RankPlayersEntry = z.infer<typeof RankPlayersEntrySchema>;

const MAX_RACE_POSITIONS = 100;

export const RacePositionSchema = z.object({
  position: z.number().int().positive(),
  prize: MoneyAmountSchema.refine(isAbsentOrPositive, 'must be above zero'),
});
export type RacePosition = z.infer<typeof RacePositionSchema>;

export const RacePositionsSchema = z
  .array(RacePositionSchema)
  .min(1)
  .max(MAX_RACE_POSITIONS)
  .refine((positions) => {
    const sorted = positions.map((p) => p.position).sort((a, b) => a - b);
    return sorted.every((position, index) => position === index + 1);
  }, 'positions must run 1..N with no gap or duplicate');
export type RacePositions = z.infer<typeof RacePositionsSchema>;

export const RaceEligibleProductsSchema = z.array(z.string().trim().min(1).max(64)).max(50);
export type RaceEligibleProducts = z.infer<typeof RaceEligibleProductsSchema>;

const RaceFieldsShape = {
  name: z.string().min(1).max(200),
  currency: CurrencyTickerSchema,
  startAt: TimestampSchema,
  endAt: TimestampSchema,
  prizePool: MoneyAmountSchema.refine(isAbsentOrPositive, 'must be above zero'),
  positions: RacePositionsSchema,
  eligibleProducts: RaceEligibleProductsSchema,
} as const;

const RaceInputShape = { ...RaceFieldsShape, eligibleProducts: EligibleProductsInputSchema };

const raceDatesOrdered = (v: { startAt: string; endAt: string }) =>
  new Date(v.endAt).getTime() > new Date(v.startAt).getTime();

export const CreateRaceInputSchema = z
  .object(RaceInputShape)
  .refine(raceDatesOrdered, { message: 'endAt must be after startAt', path: ['endAt'] });
export type CreateRaceInput = z.infer<typeof CreateRaceInputSchema>;

export const UpdateRaceInputSchema = z
  .object({ raceId: UuidSchema, ...RaceInputShape })
  .refine(raceDatesOrdered, { message: 'endAt must be after startAt', path: ['endAt'] });
export type UpdateRaceInput = z.infer<typeof UpdateRaceInputSchema>;

export const RaceSchema = z.object({
  id: UuidSchema,
  ...RaceFieldsShape,
  closedAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type Race = z.infer<typeof RaceSchema>;

export const RaceLeaderboardEntrySchema = z.object({
  userId: UuidSchema,
  username: z.string(),
  wagered: MoneyAmountSchema,
  position: z.number().int().positive(),
});
export type RaceLeaderboardEntry = z.infer<typeof RaceLeaderboardEntrySchema>;

export const RaceOwnEntrySchema = z.object({
  userId: UuidSchema,
  wagered: MoneyAmountSchema,
  position: z.number().int().positive().nullable(),
  amountToNextPaidPosition: MoneyAmountSchema.nullable(),
});
export type RaceOwnEntry = z.infer<typeof RaceOwnEntrySchema>;

export const RaceForPlayerSchema = z.object({
  race: RaceSchema,
  podium: z.array(RaceLeaderboardEntrySchema).max(3),
  leaderboard: z.array(RaceLeaderboardEntrySchema).max(MAX_RACE_POSITIONS - 3),
  own: RaceOwnEntrySchema,
  participants: z.number().int().nonnegative(),
});
export type RaceForPlayer = z.infer<typeof RaceForPlayerSchema>;

const rankChallengeHasAPrize = (t: { cashAmount: string | null; physicalItem: string | null }) =>
  t.cashAmount !== null || (t.physicalItem !== null && t.physicalItem.trim().length > 0);

export const RankChallengeTierSchema = z.object({
  id: UuidSchema,
  key: z.string().min(1),
  name: z.string().min(1),
  position: z.number().int().nonnegative(),
  wagerThreshold: MoneyAmountSchema,
  cashAmount: MoneyAmountSchema.nullable(),
  physicalItem: z.string().min(1).max(200).nullable(),
});
export type RankChallengeTier = z.infer<typeof RankChallengeTierSchema>;

export const RankChallengeClaimSchema = z.object({
  tierId: UuidSchema,
  tierKey: z.string(),
  userId: UuidSchema,
  username: z.string(),
  cashAmount: MoneyAmountSchema.nullable(),
  physicalItem: z.string().nullable(),
  claimedAt: TimestampSchema,
  physicalFulfilledAt: TimestampSchema.nullable(),
  physicalFulfillmentNote: z.string().nullable(),
});
export type RankChallengeClaim = z.infer<typeof RankChallengeClaimSchema>;

export const RankChallengeLadderTierSchema = RankChallengeTierSchema.extend({
  winnerUserId: UuidSchema.nullable(),
  winnerUsername: z.string().nullable(),
  claimedAt: TimestampSchema.nullable(),
});
export type RankChallengeLadderTier = z.infer<typeof RankChallengeLadderTierSchema>;

export const RankChallengeLadderSchema = z.object({
  currency: CurrencyTickerSchema,
  tiers: z.array(RankChallengeLadderTierSchema),
});
export type RankChallengeLadder = z.infer<typeof RankChallengeLadderSchema>;

const RankChallengeLadderVersionSchema = z.string().min(1).max(128);

export const RankChallengeAdminLadderSchema = RankChallengeLadderSchema.extend({
  version: RankChallengeLadderVersionSchema,
});
export type RankChallengeAdminLadder = z.infer<typeof RankChallengeAdminLadderSchema>;

export const RankChallengeLeaderboardEntrySchema = z.object({
  userId: UuidSchema,
  username: z.string(),
  lifetimeWagered: MoneyAmountSchema,
  position: z.number().int().positive(),
});
export type RankChallengeLeaderboardEntry = z.infer<typeof RankChallengeLeaderboardEntrySchema>;

export const PlayerRankChallengeSchema = z.object({
  currency: CurrencyTickerSchema,
  lifetimeWagered: MoneyAmountSchema,
  nextTier: RankChallengeTierSchema.nullable(),
  leaderboard: z.array(RankChallengeLeaderboardEntrySchema).max(5),
  ownPosition: z.number().int().positive().nullable(),
});
export type PlayerRankChallenge = z.infer<typeof PlayerRankChallengeSchema>;

const MAX_CHALLENGE_TIERS = 50;

const SubmittedRankChallengeTierSchema = RankChallengeTierSchema.omit({ id: true }).extend({
  id: UuidSchema.optional(),
});
export type SubmittedRankChallengeTier = z.infer<typeof SubmittedRankChallengeTierSchema>;

export const SetRankChallengeLadderInputSchema = z.object({
  version: RankChallengeLadderVersionSchema,
  currency: CurrencyTickerSchema,
  tiers: z
    .array(SubmittedRankChallengeTierSchema)
    .min(1)
    .max(MAX_CHALLENGE_TIERS)
    .refine(
      (tiers) => new Set(tiers.map((t) => t.key)).size === tiers.length,
      'two tiers share a key',
    )
    .refine(
      (tiers) => new Set(tiers.map((t) => t.position)).size === tiers.length,
      'two tiers share a position',
    )
    .refine(
      (tiers) => tiers.every(rankChallengeHasAPrize),
      'every tier needs a cash amount, a physical item, or both',
    ),
});
export type SetRankChallengeLadderInput = z.infer<typeof SetRankChallengeLadderInputSchema>;

export const MarkRankChallengeFulfilledInputSchema = z.object({
  tierId: UuidSchema,
  note: z.string().min(1).max(1000),
});
export type MarkRankChallengeFulfilledInput = z.infer<typeof MarkRankChallengeFulfilledInputSchema>;

export const RAKEBACK_ACCRUAL_STATUSES = ['accrued', 'claimed', 'reversed', 'voided'] as const;
export const RakebackAccrualStatusSchema = z.enum(RAKEBACK_ACCRUAL_STATUSES);
export type RakebackAccrualStatus = z.infer<typeof RakebackAccrualStatusSchema>;

export const RAKEBACK_CLAIM_OUTCOMES = ['claimed', 'auto_paid'] as const;
export const RakebackClaimOutcomeSchema = z.enum(RAKEBACK_CLAIM_OUTCOMES);
export type RakebackClaimOutcome = z.infer<typeof RakebackClaimOutcomeSchema>;

export const RAKEBACK_CLAIM_BLOCKERS = [
  'nothing_to_claim',
  'below_minimum',
  'restricted',
  'account_blocked',
] as const;
export const RakebackClaimBlockerSchema = z.enum(RAKEBACK_CLAIM_BLOCKERS);
export type RakebackClaimBlocker = z.infer<typeof RakebackClaimBlockerSchema>;

export const RakebackCurrencyAmountSchema = z.object({
  currency: CurrencyTickerSchema,
  amount: MoneyAmountSchema,
});
export type RakebackCurrencyAmount = z.infer<typeof RakebackCurrencyAmountSchema>;

export const RakebackUnclaimedSchema = RakebackCurrencyAmountSchema.extend({
  referenceAmount: MoneyAmountSchema.nullable(),
});
export type RakebackUnclaimed = z.infer<typeof RakebackUnclaimedSchema>;

const RakebackTotalsShape = {
  unclaimed: z.array(RakebackUnclaimedSchema),
  referenceCurrency: CurrencyTickerSchema,
  referenceTotal: MoneyAmountSchema,
} as const;

export const RakebackSummarySchema = z.object({
  ...RakebackTotalsShape,
  claimMinimum: MoneyAmountSchema,
  claimBlockedBy: RakebackClaimBlockerSchema.nullable(),
  lifetimeClaimed: z.array(RakebackCurrencyAmountSchema),
});
export type RakebackSummary = z.infer<typeof RakebackSummarySchema>;

export const ClaimRakebackInputSchema = z.object({ idempotencyKey: UuidSchema });

export const RakebackClaimResultSchema = z.object({
  claimId: UuidSchema,
  paid: z.array(RakebackCurrencyAmountSchema),
});
export type RakebackClaimResult = z.infer<typeof RakebackClaimResultSchema>;

export const RakebackAccrualSchema = z.object({
  id: UuidSchema,
  userId: UuidSchema,
  currency: CurrencyTickerSchema,
  amount: MoneyAmountSchema,
  stake: MoneyAmountSchema,
  rolledBackStake: MoneyAmountSchema,
  basis: z.enum(RAKEBACK_BASES),
  rtp: z.string().nullable(),
  ratePercent: ContributionPercentSchema,
  boostPercent: ContributionPercentSchema,
  streakMode: StreakRakebackModeSchema.nullable(),
  streakPercent: ContributionPercentSchema.nullable(),
  gameId: z.string().nullable(),
  providerGameKey: z.string().nullable(),
  providerName: z.string().nullable(),
  externalRoundId: z.string().nullable(),
  status: RakebackAccrualStatusSchema,
  claimId: UuidSchema.nullable(),
  voidedBy: UuidSchema.nullable(),
  voidReason: z.string().nullable(),
  createdAt: TimestampSchema,
  settledAt: TimestampSchema.nullable(),
});
export type RakebackAccrual = z.infer<typeof RakebackAccrualSchema>;

export const ListRakebackAccrualsInputSchema = PageQuerySchema.extend({
  userId: UuidSchema.optional(),
  status: RakebackAccrualStatusSchema.optional(),
});
export type ListRakebackAccrualsInput = z.infer<typeof ListRakebackAccrualsInputSchema>;

export const RakebackPlayerSummarySchema = z.object({
  userId: UuidSchema,
  ...RakebackTotalsShape,
  lifetimeClaimed: z.array(RakebackCurrencyAmountSchema),
});
export type RakebackPlayerSummary = z.infer<typeof RakebackPlayerSummarySchema>;

export const RakebackLiabilitySchema = z.object(RakebackTotalsShape);
export type RakebackLiability = z.infer<typeof RakebackLiabilitySchema>;

export const VoidRakebackAccrualInputSchema = z.object({
  accrualId: UuidSchema,
  reason: z.string().trim().min(1).max(500),
});
export type VoidRakebackAccrualInput = z.infer<typeof VoidRakebackAccrualInputSchema>;

export { RANK_PERIODIC_REWARD_KINDS, RANK_PERIODIC_REWARD_STATUSES };
export const RankPeriodicRewardKindSchema = z.enum(RANK_PERIODIC_REWARD_KINDS);
export type RankPeriodicRewardKind = z.infer<typeof RankPeriodicRewardKindSchema>;

export const RankPeriodicRewardStatusSchema = z.enum(RANK_PERIODIC_REWARD_STATUSES);
export type RankPeriodicRewardStatus = z.infer<typeof RankPeriodicRewardStatusSchema>;

export const RANK_REWARD_CLAIM_BLOCKERS = ['restricted', 'account_blocked'] as const;
export const RankRewardClaimBlockerSchema = z.enum(RANK_REWARD_CLAIM_BLOCKERS);
export type RankRewardClaimBlocker = z.infer<typeof RankRewardClaimBlockerSchema>;

export const RankPeriodicRewardSchema = z.object({
  id: UuidSchema,
  kind: RankPeriodicRewardKindSchema,
  periodKey: z.string(),
  periodStart: TimestampSchema,
  periodEnd: TimestampSchema,
  currency: CurrencyTickerSchema,
  amount: MoneyAmountSchema,
  status: RankPeriodicRewardStatusSchema,
  createdAt: TimestampSchema,
  settledAt: TimestampSchema.nullable(),
});
export type RankPeriodicReward = z.infer<typeof RankPeriodicRewardSchema>;

export const RANK_REWARDS_RECENT_LIMIT = 20;
export const RANK_REWARDS_CLAIMABLE_LIMIT = 100;
export const RANK_PERIODIC_REWARD_PROVIDER_NAME = 'rank-periodic-reward';

export const RankPeriodicRewardsSchema = z.object({
  claimable: z.array(RankPeriodicRewardSchema).max(RANK_REWARDS_CLAIMABLE_LIMIT),
  recent: z.array(RankPeriodicRewardSchema).max(RANK_REWARDS_RECENT_LIMIT),
  claimBlockedBy: RankRewardClaimBlockerSchema.nullable(),
});
export type RankPeriodicRewards = z.infer<typeof RankPeriodicRewardsSchema>;

export const ClaimRankPeriodicRewardInputSchema = z.object({
  rewardId: UuidSchema,
  idempotencyKey: UuidSchema,
});

export const RankPeriodicRewardClaimResultSchema = z.object({
  rewardId: UuidSchema,
  kind: RankPeriodicRewardKindSchema,
  currency: CurrencyTickerSchema,
  amount: MoneyAmountSchema,
});
export type RankPeriodicRewardClaimResult = z.infer<typeof RankPeriodicRewardClaimResultSchema>;

export const AdminRankPeriodicRewardSchema = RankPeriodicRewardSchema.extend({
  userId: UuidSchema,
  tierId: UuidSchema,
  ladderCurrency: CurrencyTickerSchema,
  ladderAmount: MoneyAmountSchema,
  transactionId: UuidSchema.nullable(),
});
export type AdminRankPeriodicReward = z.infer<typeof AdminRankPeriodicRewardSchema>;

export const ListRankPeriodicRewardsInputSchema = PageQuerySchema.extend({
  userId: UuidSchema.optional(),
  status: RankPeriodicRewardStatusSchema.optional(),
  kind: RankPeriodicRewardKindSchema.optional(),
});
export type ListRankPeriodicRewardsInput = z.infer<typeof ListRankPeriodicRewardsInputSchema>;

export const gamificationContract = {
  ranks: {
    get: oc.route({ method: 'GET', path: '/promo/ranks' }).output(PlayerRankSchema),

    ladder: oc.route({ method: 'GET', path: '/promo/ranks/ladder' }).output(RankLadderSchema),

    lookup: oc
      .route({ method: 'POST', path: '/promo/ranks/lookup' })
      .input(RankLookupInputSchema)
      .output(z.array(RankLookupEntrySchema)),

    players: oc
      .route({ method: 'GET', path: '/promo/ranks/players' })
      .output(z.array(RankPlayersEntrySchema)),

    rewards: oc
      .route({ method: 'GET', path: '/promo/ranks/rewards' })
      .output(RankPeriodicRewardsSchema),

    claimReward: oc
      .route({ method: 'POST', path: '/promo/ranks/rewards/{rewardId}/claim' })
      .input(ClaimRankPeriodicRewardInputSchema)
      .output(RankPeriodicRewardClaimResultSchema),
  },

  streaks: {
    get: oc.route({ method: 'GET', path: '/promo/streaks' }).output(PlayerStreakSchema),
    claim: oc
      .route({ method: 'POST', path: '/promo/streaks/claim' })
      .input(ClaimStreakMilestoneInputSchema)
      .output(StreakClaimResultSchema),
    leaderboard: oc
      .route({ method: 'GET', path: '/promo/streaks/leaderboard' })
      .output(StreakLeaderboardSchema),
  },

  races: {
    listActive: oc.route({ method: 'GET', path: '/promo/races' }).output(z.array(RaceSchema)),

    get: oc
      .route({ method: 'GET', path: '/promo/races/{raceId}' })
      .input(z.object({ raceId: UuidSchema }))
      .output(RaceForPlayerSchema),
  },

  rankChallenge: {
    get: oc
      .route({ method: 'GET', path: '/promo/rank-challenge' })
      .output(PlayerRankChallengeSchema),

    ladder: oc
      .route({ method: 'GET', path: '/promo/rank-challenge/ladder' })
      .output(RankChallengeLadderSchema),
  },

  rakeback: {
    summary: oc.route({ method: 'GET', path: '/promo/rakeback' }).output(RakebackSummarySchema),

    claim: oc
      .route({ method: 'POST', path: '/promo/rakeback/claim' })
      .input(ClaimRakebackInputSchema)
      .output(RakebackClaimResultSchema),
  },

  admin: {
    rakeback: {
      listAccruals: oc
        .route({ method: 'GET', path: '/backoffice/promo/rakeback/accruals' })
        .input(ListRakebackAccrualsInputSchema)
        .output(paginated(RakebackAccrualSchema)),

      playerSummary: oc
        .route({ method: 'GET', path: '/backoffice/promo/rakeback/players/{userId}' })
        .input(z.object({ userId: UuidSchema }))
        .output(RakebackPlayerSummarySchema),

      liability: oc
        .route({ method: 'GET', path: '/backoffice/promo/rakeback/liability' })
        .output(RakebackLiabilitySchema),

      void: oc
        .route({ method: 'POST', path: '/backoffice/promo/rakeback/accruals/{accrualId}/void' })
        .input(VoidRakebackAccrualInputSchema)
        .output(RakebackAccrualSchema),
    },

    streaks: {
      config: {
        get: oc
          .route({ method: 'GET', path: '/backoffice/promo/streaks/config' })
          .output(StreakConfigSchema),

        set: oc
          .route({ method: 'PUT', path: '/backoffice/promo/streaks/config' })
          .input(SetStreakConfigInputSchema)
          .output(StreakConfigSchema),
      },
    },

    ranks: {
      get: oc.route({ method: 'GET', path: '/backoffice/promo/ranks' }).output(RankLadderSchema),

      set: oc
        .route({ method: 'PUT', path: '/backoffice/promo/ranks' })
        .input(SetRankLadderInputSchema)
        .output(RankLadderSchema),

      rewards: oc
        .route({ method: 'GET', path: '/backoffice/promo/ranks/rewards' })
        .input(ListRankPeriodicRewardsInputSchema)
        .output(paginated(AdminRankPeriodicRewardSchema)),

      config: {
        get: oc
          .route({ method: 'GET', path: '/backoffice/promo/ranks/config' })
          .output(RankConfigSchema),

        set: oc
          .route({ method: 'PUT', path: '/backoffice/promo/ranks/config' })
          .input(SetRankConfigInputSchema)
          .output(RankConfigSchema),
      },
    },

    races: {
      list: oc
        .route({ method: 'GET', path: '/backoffice/promo/races' })
        .output(z.array(RaceSchema)),

      get: oc
        .route({ method: 'GET', path: '/backoffice/promo/races/{raceId}' })
        .input(z.object({ raceId: UuidSchema }))
        .output(RaceSchema),

      create: oc
        .route({ method: 'POST', path: '/backoffice/promo/races' })
        .input(CreateRaceInputSchema)
        .output(RaceSchema),

      update: oc
        .route({ method: 'PUT', path: '/backoffice/promo/races/{raceId}' })
        .input(UpdateRaceInputSchema)
        .output(RaceSchema),
    },

    rankChallenge: {
      config: {
        get: oc
          .route({ method: 'GET', path: '/backoffice/promo/rank-challenge' })
          .output(RankChallengeAdminLadderSchema),

        set: oc
          .route({ method: 'PUT', path: '/backoffice/promo/rank-challenge' })
          .input(SetRankChallengeLadderInputSchema)
          .output(RankChallengeAdminLadderSchema),
      },

      claims: {
        list: oc
          .route({ method: 'GET', path: '/backoffice/promo/rank-challenge/claims' })
          .output(z.array(RankChallengeClaimSchema)),
      },

      fulfilment: {
        list: oc
          .route({ method: 'GET', path: '/backoffice/promo/rank-challenge/fulfilment' })
          .output(z.array(RankChallengeClaimSchema)),

        markFulfilled: oc
          .route({ method: 'POST', path: '/backoffice/promo/rank-challenge/fulfilment/{tierId}' })
          .input(MarkRankChallengeFulfilledInputSchema)
          .output(RankChallengeClaimSchema),
      },
    },
  },
};

export * from './agent-tools.js';
