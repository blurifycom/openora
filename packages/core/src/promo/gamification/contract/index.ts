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

const EditableTierSchema = RankTierSchema.pick({
  id: true,
  wagerThreshold: true,
  rakebackPercent: true,
  dailyBonus: true,
  weeklyBonus: true,
  monthlyBonus: true,
  levelUpBonus: true,
});

/**
 * The ladder is replaced as one set: a per-tier surface would let an operator save thresholds
 * that no longer increase. The tiers themselves are fixed - a key, name, position or currency is
 * never editable, because the player-facing images and translations are keyed off `key`.
 */
export const SetRankLadderInputSchema = z.object({
  tiers: z
    .array(EditableTierSchema)
    .min(1)
    .max(MAX_TIERS)
    .refine(
      (tiers) => new Set(tiers.map((tier) => tier.id)).size === tiers.length,
      'two entries target the same tier',
    )
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

export const gamificationContract = {
  ranks: {
    get: oc.route({ method: 'GET', path: '/promo/ranks' }).output(PlayerRankSchema),
  },

  admin: {
    ranks: {
      get: oc.route({ method: 'GET', path: '/backoffice/promo/ranks' }).output(RankLadderSchema),

      set: oc
        .route({ method: 'PUT', path: '/backoffice/promo/ranks' })
        .input(SetRankLadderInputSchema)
        .output(RankLadderSchema),
    },
  },
};
