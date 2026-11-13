import { oc } from '@orpc/contract';
import * as z from 'zod';
import { PageQuerySchema, paginated } from '@openora/core/contracts/kit';
import {
  ContributionPercentSchema,
  CurrencyTickerSchema,
  MoneyAmountSchema,
  RAKEBACK_BASES,
  RANK_PERIODIC_BASES,
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
  /**
   * Under the `margin` periodic basis, the percent of the period's margin each bonus pays, capped
   * by the matching amount above (no cap when that is null). Null pays nothing of that kind.
   */
  dailyBonusPercent: ContributionPercentSchema.nullable(),
  weeklyBonusPercent: ContributionPercentSchema.nullable(),
  monthlyBonusPercent: ContributionPercentSchema.nullable(),
});

export type RankTier = z.infer<typeof RankTierSchema>;

/** `flat` pays the daily, weekly and monthly amounts; `margin` pays their percents of the margin. */
const RankPeriodicBasisSchema = z.enum(RANK_PERIODIC_BASES);

export const PlayerRankSchema = z.object({
  currency: CurrencyTickerSchema,
  periodicBasis: RankPeriodicBasisSchema,
  lifetimeWagered: MoneyAmountSchema,
  tierId: UuidSchema.nullable(),
  tiers: z.array(RankTierSchema),
});

export type PlayerRank = z.infer<typeof PlayerRankSchema>;

export const RankLadderSchema = z.object({
  currency: CurrencyTickerSchema,
  periodicBasis: RankPeriodicBasisSchema,
  tiers: z.array(RankTierSchema),
});

export type RankLadder = z.infer<typeof RankLadderSchema>;

const MAX_TIERS = 50;

/**
 * A tier as an operator submits it. No `id` means a tier to create; position is the entry's place
 * in the array, so a ladder is reordered by reordering it. A percent left out keeps what the tier
 * holds, and is null on a new tier.
 */
const SubmittedTierSchema = RankTierSchema.omit({ id: true, position: true }).extend({
  id: UuidSchema.optional(),
  dailyBonusPercent: ContributionPercentSchema.nullable().optional(),
  weeklyBonusPercent: ContributionPercentSchema.nullable().optional(),
  monthlyBonusPercent: ContributionPercentSchema.nullable().optional(),
});

export type SubmittedRankTier = z.infer<typeof SubmittedTierSchema>;

/**
 * The ladder is replaced as one set: a per-tier surface would let an operator save thresholds
 * that no longer increase, and it could not express a tier being added, removed or moved.
 */
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

// MoneyAmountSchema has already rejected anything negative or malformed, so a single non-zero
// digit is the exact test for "above zero" - and it never rounds the way a float would.
const isAbsentOrPositive = (amount: string | null) => amount === null || /[1-9]/.test(amount);

// ContributionPercentSchema allows at most two decimals, so hundredths add exactly as integers.
const hundredths = (percent: string | null | undefined) => {
  const [whole = '0', fraction = ''] = (percent ?? '0').split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
};

/**
 * One bet can pay rakeback and all three periodic bonuses, so their percents together stay at or
 * under 100. On the `stake` rakeback basis rakeback is a share of turnover, not of the edge. A
 * percent not set counts as zero.
 */
export const paysOverHouseEdge = (tier: {
  rakebackPercent: string;
  dailyBonusPercent?: string | null | undefined;
  weeklyBonusPercent?: string | null | undefined;
  monthlyBonusPercent?: string | null | undefined;
}) =>
  hundredths(tier.rakebackPercent) +
    PERCENT_FIELDS.reduce((sum, field) => sum + hundredths(tier[field]), 0) >
  100 * 100;

/** What a rank pays out on a schedule: the level-up bonuses owed, and each periodic bonus. */
export const RANK_PAYOUT_KINDS = ['levelUp', 'daily', 'weekly', 'monthly'] as const;
export const RankPayoutKindSchema = z.enum(RANK_PAYOUT_KINDS);
export type RankPayoutKind = z.infer<typeof RankPayoutKindSchema>;

const MAX_EXPIRY_DAYS = 365;

export const RankRewardTermsSchema = z.object({
  /**
   * Wagering requirement as a multiple of the reward, as a decimal string above zero. Its upper
   * bound is the bonus engine's, checked by the service, since comparing it needs decimal math.
   */
  wageringMultiplier: MoneyAmountSchema.refine(isAbsentOrPositive, 'must be above zero'),
  expiryDays: z.number().int().positive().max(MAX_EXPIRY_DAYS),
  /**
   * Largest single stake allowed while this reward is being wagered. Absent for no limit, which
   * lets a player put the whole bonus on one spin and turn a wagering requirement into a coin
   * flip. Enforced by the bonus engine inside the bet, against the terms the grant was made
   * under, so changing it never touches a bonus a player already holds.
   *
   * Priced in the ladder's currency like every other amount, and converted with the reward when
   * the reward is credited in another.
   */
  maxBet: MoneyAmountSchema.refine(isAbsentOrPositive, 'must be above zero').nullish(),
  /**
   * Cap on what this reward can ever convert into real money, as a multiple of the amount
   * granted. Absent for no cap - and without one, a modest bonus can compound into a payout
   * nobody priced.
   */
  maxWinMultiplier: MoneyAmountSchema.refine(isAbsentOrPositive, 'must be above zero').nullish(),
});

/**
 * Ladder-wide settings. A reward kind left out is not paid, whatever amount a tier carries for
 * it - an amount without terms is a bonus nobody decided how to wager.
 */
/**
 * When a periodic payout lands, and therefore what period it pays for: the two are one setting,
 * so a payout can never run on a Friday for a Monday-to-Monday week. All in UTC.
 */
export const RankPayoutAnchorsSchema = z.object({
  /** Hour a day's payout closes on, 0-23. */
  dailyHour: z.number().int().min(0).max(23),
  /** Weekday a week closes on, ISO-8601: 1 is Monday, 7 is Sunday. */
  weeklyDay: z.number().int().min(1).max(7),
  /** Day of the month a month closes on. Capped at 28, the last day every month has. */
  monthlyDay: z.number().int().min(1).max(28),
});

export type RankPayoutAnchors = z.infer<typeof RankPayoutAnchorsSchema>;

export const DEFAULT_PAYOUT_ANCHORS: RankPayoutAnchors = {
  dailyHour: 0,
  weeklyDay: 1,
  monthlyDay: 1,
};

/**
 * What rakeback and the rank challenge count when the operator has set no list of their own:
 * every product but sportsbook, whose stakes still count toward the rank itself.
 */
export const DEFAULT_RANK_PERK_PRODUCTS = [
  'casino',
  'live-casino',
  'pvp',
] as const satisfies readonly WagerProduct[];

/** Empty counts every product. */
const RankPerkProductsSchema = z.array(z.enum(WAGER_PRODUCTS)).max(WAGER_PRODUCTS.length);

export const RankConfigSchema = z.object({
  /**
   * What a rank reward is actually credited in, when that differs from the ladder's own
   * currency. An operator whose ladder is priced in a unit it cannot pay out - a fiat ticker on
   * a crypto-only wallet, say - names the currency the money lands in here, and the amount is
   * converted at the rate of the moment it is granted. Absent means the ladder pays in the
   * currency it is priced in, which is the common case and converts nothing.
   */
  payoutCurrency: CurrencyTickerSchema.nullish(),
  /**
   * Credit a reward in the currency the player actually plays in, rather than one fixed
   * currency. A bonus is attributed to the currency it was granted in and can only be wagered
   * by bets in that same currency, so a player who only ever bets in one coin cannot use a
   * bonus paid in another. Falls back to `payoutCurrency` - and then to the ladder's own - when
   * the player's currency is unknown or has no rate.
   */
  payInPlayerCurrency: z.boolean().prefault(false),
  /**
   * Pay a periodic bonus only to players who wagered during the period it covers. Off pays
   * every player holding a rank that carries an amount, including one who has not played in
   * months.
   */
  periodicRequiresActivity: z.boolean().prefault(true),
  /**
   * How much a player has to wager inside the period to qualify for its bonus, in the ladder's
   * currency. `null` means any single bet qualifies, which is what "played" meant before there
   * was a number to put on it. A save that leaves it out keeps the stored value.
   */
  periodicMinimumWager: MoneyAmountSchema.refine(
    isAbsentOrPositive,
    'must be above zero',
  ).nullish(),
  /** Products whose stakes count toward a rank. Empty counts every product. */
  eligibleProducts: z.array(z.string().trim().min(1).max(64)).max(50),
  /** Products whose stakes earn rakeback. A stake must count toward the rank as well. */
  rakebackEligibleProducts: RankPerkProductsSchema,
  /** Products whose stakes count toward the rank challenge. */
  rankChallengeEligibleProducts: RankPerkProductsSchema,
  rewards: z
    .object({
      levelUp: RankRewardTermsSchema,
      daily: RankRewardTermsSchema,
      weekly: RankRewardTermsSchema,
      monthly: RankRewardTermsSchema,
    })
    .partial(),
  payoutAnchors: RankPayoutAnchorsSchema.prefault(DEFAULT_PAYOUT_ANCHORS),
});

export type RankConfig = z.infer<typeof RankConfigSchema>;

/**
 * A list left out keeps what is stored, or `DEFAULT_RANK_PERK_PRODUCTS` on the first save. A
 * `periodicMinimumWager` left out keeps what is stored, or `null`.
 */
export const SetRankConfigInputSchema = RankConfigSchema.extend({
  rakebackEligibleProducts: RankPerkProductsSchema.optional(),
  rankChallengeEligibleProducts: RankPerkProductsSchema.optional(),
});
export type SetRankConfigInput = z.infer<typeof SetRankConfigInputSchema>;
export type RankConfigInput = z.input<typeof SetRankConfigInputSchema>;

/** Every streak amount and threshold is priced in this currency; a bet is converted into it when counted. */
export const STREAK_CURRENCY = 'USD';
/** The longest streak day an operator can attach a rate or a reward to. The count itself has no upper limit. */
export const STREAK_MAX_DAY = 35;
const STREAK_MAX_ROLLOVER_MULTIPLIER = 1000;
const STREAK_MAX_CLAIM_EXPIRY_DAYS = 365;

export const STREAK_RAKEBACK_MODES = ['unranked', 'ranked'] as const;
export const StreakRakebackModeSchema = z.enum(STREAK_RAKEBACK_MODES);
export type StreakRakebackMode = z.infer<typeof StreakRakebackModeSchema>;

export const STREAK_FIXED_REWARD_STATES = ['locked', 'claimable', 'claimed', 'expired'] as const;
export const StreakFixedRewardStateSchema = z.enum(STREAK_FIXED_REWARD_STATES);
export type StreakFixedRewardState = z.infer<typeof StreakFixedRewardStateSchema>;

/** Why a streak reward row settled without paying: `reversed` is a same-day rollback of the day that unlocked it. */
export const STREAK_GRANT_OUTCOMES = ['granted', 'restricted', 'reversed', 'expired'] as const;
export type StreakGrantOutcome = (typeof STREAK_GRANT_OUTCOMES)[number];

// Zod runs a refine even when the format check before it failed, so a malformed value reaches
// here too; it passes, leaving the format error as the one reported.
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

/**
 * From `day` on, a qualifying player earns rakeback at this rate until a later milestone replaces
 * it. A player with no rank earns `unrankedRatePercent` of the theoretical gross gaming revenue
 * of their bets; a ranked player's rank rakeback is multiplied by `1 + rankedUpliftPercent / 100`.
 */
export const StreakRakebackMilestoneSchema = z.object({
  day: StreakDaySchema,
  unrankedRatePercent: ContributionPercentSchema,
  rankedUpliftPercent: ContributionPercentSchema,
});
export type StreakRakebackMilestone = z.infer<typeof StreakRakebackMilestoneSchema>;

/**
 * A one-time bonus unlocked the first time a player's streak reaches `day`. The amount is in
 * `STREAK_CURRENCY`; the rollover and the claim window are captured with it when the day is
 * reached, so a later edit never changes a reward a player already holds.
 */
export const StreakFixedRewardSchema = z.object({
  day: StreakDaySchema,
  amount: MoneyAmountSchema.refine(isAbsentOrPositive, 'must be above zero'),
  rolloverMultiplier: MoneyAmountSchema.refine(isAbsentOrPositive, 'must be above zero').refine(
    isRolloverWithinLimit,
    `must not exceed ${STREAK_MAX_ROLLOVER_MULTIPLIER}`,
  ),
  claimExpiryDays: z.number().int().min(1).max(STREAK_MAX_CLAIM_EXPIRY_DAYS),
  /** Largest single stake allowed while the bonus is wagered, in `STREAK_CURRENCY`; absent for no limit. */
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
  /** Off, no day counts and no rate applies; rewards already unlocked stay claimable. */
  enabled: z.boolean(),
  /**
   * What a player must wager in a day, priced in `STREAK_CURRENCY`, for the day to count. Zero
   * means no threshold was ever set in dollars, as on a config converted from another currency;
   * it can be read but not saved, and a streak with it counts nothing.
   */
  dailyMinWager: MoneyAmountSchema,
  /** Products whose stakes count toward the streak. Empty counts every product. */
  eligibleProducts: z.array(z.string().trim().min(1).max(64)).max(50),
  rakebackMilestones: dayOrdered(StreakRakebackMilestoneSchema),
  fixedRewards: dayOrdered(StreakFixedRewardSchema),
});
export type StreakConfig = z.infer<typeof StreakConfigSchema>;

export const SetStreakConfigInputSchema = StreakConfigSchema.extend({
  dailyMinWager: MoneyAmountSchema.refine(isAbsentOrPositive, 'must be above zero'),
});

export const StreakActiveRateSchema = z.object({
  mode: StreakRakebackModeSchema,
  percent: ContributionPercentSchema,
});
export type StreakActiveRate = z.infer<typeof StreakActiveRateSchema>;

/** The next day above the current streak that earns a rate or unlocks a reward. */
export const StreakNextMilestoneSchema = z.object({
  day: StreakDaySchema,
  rakeback: StreakRakebackMilestoneSchema.nullable(),
  fixedReward: StreakFixedRewardSchema.nullable(),
});
export type StreakNextMilestone = z.infer<typeof StreakNextMilestoneSchema>;

/**
 * A fixed reward as the player sees it. Once unlocked the amount, rollover and claim window are
 * the ones captured then, not the config's current ones. `expired` also covers a reward lost to a
 * responsible-gambling block.
 */
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
  /** The rate the player's next qualifying bet earns; null when none applies. */
  activeRate: StreakActiveRateSchema.nullable(),
  nextMilestone: StreakNextMilestoneSchema.nullable(),
  rakebackMilestones: z.array(StreakRakebackMilestoneSchema),
  fixedRewards: z.array(PlayerStreakFixedRewardSchema),
});
export type PlayerStreak = z.infer<typeof PlayerStreakSchema>;

/** Why a player's unclaimed streak rewards were forfeited: the responsible-gambling block that started. */
export const StreakForfeitReasonSchema = z.enum(['self_exclusion', 'cooling_off']);
export type StreakForfeitReason = z.infer<typeof StreakForfeitReasonSchema>;

export const ClaimStreakMilestoneInputSchema = z.object({ milestoneGrantId: UuidSchema });

/** `restricted`: the player is under a responsible-gambling block, so the reward is forfeited. */
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
  /** The requesting player's own rank on the board, 1-based; null when they have no streak. */
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

/** How many players hold a tier right now. */
export const RankPlayersEntrySchema = z.object({
  tierId: UuidSchema,
  players: z.number().int().nonnegative(),
});
export type RankPlayersEntry = z.infer<typeof RankPlayersEntrySchema>;

// A race's leaderboard is capped rather than paginated - see RaceService.getForPlayer.
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

const RaceEligibleProductsInputSchema = z
  .array(WagerProductSchema)
  .min(1, 'select at least one product')
  .refine((products) => new Set(products).size === products.length, 'products must not repeat');

const RaceFieldsShape = {
  name: z.string().min(1).max(200),
  currency: CurrencyTickerSchema,
  startAt: TimestampSchema,
  endAt: TimestampSchema,
  prizePool: MoneyAmountSchema.refine(isAbsentOrPositive, 'must be above zero'),
  positions: RacePositionsSchema,
  /** Products whose stakes count toward this race. */
  eligibleProducts: RaceEligibleProductsSchema,
} as const;

const RaceInputShape = { ...RaceFieldsShape, eligibleProducts: RaceEligibleProductsInputSchema };

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

/** A public leaderboard row: masked or "Incognito" per the player's own privacy setting. */
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
  /** Null when the player has not wagered in this race at all. */
  position: z.number().int().positive().nullable(),
  /** How much more the player must wager to reach the next paid position. Null once they are
   * already in a paid position, or the race pays no positions. */
  amountToNextPaidPosition: MoneyAmountSchema.nullable(),
});
export type RaceOwnEntry = z.infer<typeof RaceOwnEntrySchema>;

export const RaceForPlayerSchema = z.object({
  race: RaceSchema,
  podium: z.array(RaceLeaderboardEntrySchema).max(3),
  /** Positions 4 and below, capped - see RaceService.getForPlayer. */
  leaderboard: z.array(RaceLeaderboardEntrySchema).max(MAX_RACE_POSITIONS - 3),
  own: RaceOwnEntrySchema,
  /** Everyone with a wager in the race, uncapped - the "of N" beside the player's position. */
  participants: z.number().int().nonnegative(),
});
export type RaceForPlayer = z.infer<typeof RaceForPlayerSchema>;

// A tier may carry a cash amount, a physical item, or both (master/titan) - at least one.
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

/** Opaque token that changes on every ladder edit; echo it back on save. */
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
  /** The next tier the player has not yet claimed and nobody else has either. Null once every
   * tier is claimed. */
  nextTier: RankChallengeTierSchema.nullable(),
  leaderboard: z.array(RankChallengeLeaderboardEntrySchema).max(5),
  /** The player's own 1-based position; null when outside the top 5 shown, or no wagers yet. */
  ownPosition: z.number().int().positive().nullable(),
});
export type PlayerRankChallenge = z.infer<typeof PlayerRankChallengeSchema>;

const MAX_CHALLENGE_TIERS = 50;

const SubmittedRankChallengeTierSchema = RankChallengeTierSchema.omit({ id: true }).extend({
  id: UuidSchema.optional(),
});
export type SubmittedRankChallengeTier = z.infer<typeof SubmittedRankChallengeTierSchema>;

export const SetRankChallengeLadderInputSchema = z.object({
  /** The `version` the edit was made against; a stale one is refused with CONFLICT. */
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

// Keyed by tierId, not a claim row id: `promoRankChallengeClaim.tierId` is unique per claim
// (see schema/index.ts) and the API's own RankChallengeClaimSchema never exposes a row id, so
// this is the one identifier the admin UI already has on hand from every claim/queue listing.
export const MarkRankChallengeFulfilledInputSchema = z.object({
  tierId: UuidSchema,
  note: z.string().min(1).max(1000),
});
export type MarkRankChallengeFulfilledInput = z.infer<typeof MarkRankChallengeFulfilledInputSchema>;

export const RAKEBACK_ACCRUAL_STATUSES = ['accrued', 'claimed', 'reversed', 'voided'] as const;
export const RakebackAccrualStatusSchema = z.enum(RAKEBACK_ACCRUAL_STATUSES);
export type RakebackAccrualStatus = z.infer<typeof RakebackAccrualStatusSchema>;

/** `auto_paid`: paid without a claim, on self-exclusion, account closure or the daily sweep. */
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
  /** Null when there is no rate into the reference currency; it then counts 0 toward the minimum. */
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
  /** Why a claim would be refused right now; null when it would pay. */
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
  /** The own-money stake the amount was computed from, net of any partial rollback. */
  stake: MoneyAmountSchema,
  /** Stake of a claimed or voided row taken back by a later rollback; its amount is not reduced. */
  rolledBackStake: MoneyAmountSchema,
  basis: z.enum(RAKEBACK_BASES),
  /** Null under the stake basis. */
  rtp: z.string().nullable(),
  ratePercent: ContributionPercentSchema,
  /** Always zero on a row priced after the additive boost was retired; kept for earlier rows. */
  boostPercent: ContributionPercentSchema,
  /** Which streak formula raised this row; null when the streak did not change the amount. */
  streakMode: StreakRakebackModeSchema.nullable(),
  /** The unranked rate or the uplift the streak applied; null together with `streakMode`. */
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
  /** When the row left `accrued`. */
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

export const gamificationContract = {
  ranks: {
    get: oc.route({ method: 'GET', path: '/promo/ranks' }).output(PlayerRankSchema),

    /**
     * The ladder on its own, for anyone: what a rank asks for and pays is the operator's own
     * marketing, and the page that shows it is public. Carries no player data at all.
     */
    ladder: oc.route({ method: 'GET', path: '/promo/ranks/ladder' }).output(RankLadderSchema),

    /**
     * Another player's rank badge, batched - a chat avatar or profile card names whose rank it
     * wants rather than firing one request per avatar on screen. Public fields only: a tier's
     * key and display name, never wagered amounts or rakeback.
     */
    lookup: oc
      .route({ method: 'POST', path: '/promo/ranks/lookup' })
      .input(RankLookupInputSchema)
      .output(z.array(RankLookupEntrySchema)),

    /** Players per tier, for the public ladder page. Counts only, no player data. */
    players: oc
      .route({ method: 'GET', path: '/promo/ranks/players' })
      .output(z.array(RankPlayersEntrySchema)),
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
    /** Races open right now, for the race switcher. */
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

    /** The tiers and who has won each so far - public, no wagered totals. */
    ladder: oc
      .route({ method: 'GET', path: '/promo/rank-challenge/ladder' })
      .output(RankChallengeLadderSchema),
  },

  rakeback: {
    /** What the player has accrued and not claimed, per currency, and whether a claim would pay. */
    summary: oc.route({ method: 'GET', path: '/promo/rakeback' }).output(RakebackSummarySchema),

    /** Pays every unclaimed accrual, each currency to its own real balance. */
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

      /** Unclaimed rakeback across every player: what the operator owes. */
      liability: oc
        .route({ method: 'GET', path: '/backoffice/promo/rakeback/liability' })
        .output(RakebackLiabilitySchema),

      /** Cancels an unclaimed accrual. A claimed one is corrected by a manual adjustment. */
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
