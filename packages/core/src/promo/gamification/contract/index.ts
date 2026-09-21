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

export const gamificationContract = {
  ranks: {
    get: oc.route({ method: 'GET', path: '/promo/ranks' }).output(PlayerRankSchema),
  },
};
