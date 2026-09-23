import { oc } from '@orpc/contract';
import * as z from 'zod';
import {
  ContributionPercentSchema,
  CurrencyTickerSchema,
  MoneyAmountSchema,
  UuidSchema,
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
});

export type RankTier = z.infer<typeof RankTierSchema>;

export const PlayerRankSchema = z.object({
  currency: CurrencyTickerSchema,
  lifetimeWagered: MoneyAmountSchema,
  tierId: UuidSchema.nullable(),
  tiers: z.array(RankTierSchema),
});

export type PlayerRank = z.infer<typeof PlayerRankSchema>;

export const RankLadderSchema = z.object({
  currency: CurrencyTickerSchema,
  tiers: z.array(RankTierSchema),
});

export type RankLadder = z.infer<typeof RankLadderSchema>;

const MAX_TIERS = 50;

/**
 * A tier as an operator submits it. No `id` means a tier to create; position is the entry's place
 * in the array, so a ladder is reordered by reordering it.
 */
const SubmittedTierSchema = RankTierSchema.omit({ id: true, position: true }).extend({
  id: UuidSchema.optional(),
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
    ),
});

export type SetRankLadderInput = z.infer<typeof SetRankLadderInputSchema>;

const BONUS_FIELDS = ['dailyBonus', 'weeklyBonus', 'monthlyBonus', 'levelUpBonus'] as const;

// MoneyAmountSchema has already rejected anything negative or malformed, so a single non-zero
// digit is the exact test for "above zero" - and it never rounds the way a float would.
const isAbsentOrPositive = (amount: string | null) => amount === null || /[1-9]/.test(amount);

/** What a rank pays out on a schedule: the level-up bonuses owed, and each periodic bonus. */
export const RANK_PAYOUT_KINDS = ['levelUp', 'daily', 'weekly', 'monthly'] as const;
export const RankPayoutKindSchema = z.enum(RANK_PAYOUT_KINDS);
export type RankPayoutKind = z.infer<typeof RankPayoutKindSchema>;

const MAX_EXPIRY_DAYS = 365;

const RankRewardTermsSchema = z.object({
  /**
   * Wagering requirement as a multiple of the reward, as a decimal string above zero. Its upper
   * bound is the bonus engine's, checked by the service, since comparing it needs decimal math.
   */
  wageringMultiplier: MoneyAmountSchema.refine(isAbsentOrPositive, 'must be above zero'),
  expiryDays: z.number().int().positive().max(MAX_EXPIRY_DAYS),
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

export const RankConfigSchema = z.object({
  /**
   * What a rank reward is actually credited in, when that differs from the ladder's own
   * currency. An operator whose ladder is priced in a unit it cannot pay out - a fiat ticker on
   * a crypto-only wallet, say - names the currency the money lands in here, and the amount is
   * converted at the rate of the moment it is granted. Absent means the ladder pays in the
   * currency it is priced in, which is the common case and converts nothing.
   */
  payoutCurrency: CurrencyTickerSchema.nullish(),
  /** Products whose stakes count toward a rank. Empty counts every product. */
  eligibleProducts: z.array(z.string().trim().min(1).max(64)).max(50),
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

export const gamificationContract = {
  ranks: {
    get: oc.route({ method: 'GET', path: '/promo/ranks' }).output(PlayerRankSchema),

    /**
     * The ladder on its own, for anyone: what a rank asks for and pays is the operator's own
     * marketing, and the page that shows it is public. Carries no player data at all.
     */
    ladder: oc.route({ method: 'GET', path: '/promo/ranks/ladder' }).output(RankLadderSchema),
  },

  admin: {
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
          .input(RankConfigSchema)
          .output(RankConfigSchema),
      },
    },
  },
};
