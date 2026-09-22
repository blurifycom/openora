import { asc, eq, sql } from 'drizzle-orm';
import type {
  ExchangeRateReader,
  WagerTrackingArgs,
  WagerTrackingCommands,
} from '@openora/core/contracts';
import {
  makeNotFoundError,
  moneyCompare,
  type DrizzleService,
  type DrizzleTx,
} from '@openora/core/server';
import {
  promoPlayerRank,
  promoRankTier,
  type PromoPlayerRank,
  type PromoRankTier,
} from '../schema/index.js';

export const RankLadderNotConfiguredError = makeNotFoundError('RankLadder');

type LadderRung = Pick<PromoRankTier, 'id' | 'position' | 'wagerThreshold'>;

const tierFor = <T extends LadderRung>(ladder: readonly T[], lifetime: string) =>
  ladder.filter((tier) => moneyCompare(tier.wagerThreshold, lifetime) <= 0).at(-1);

const TIER_COLUMNS = {
  id: promoRankTier.id,
  key: promoRankTier.key,
  name: promoRankTier.name,
  position: promoRankTier.position,
  wagerThreshold: promoRankTier.wagerThreshold,
  rakebackPercent: promoRankTier.rakebackPercent,
  dailyBonus: promoRankTier.dailyBonus,
  weeklyBonus: promoRankTier.weeklyBonus,
  monthlyBonus: promoRankTier.monthlyBonus,
  levelUpBonus: promoRankTier.levelUpBonus,
};

export class RankService implements WagerTrackingCommands {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly rates: ExchangeRateReader,
    private readonly logger: { warn: (context: object, message: string) => void },
  ) {}

  /**
   * Adds a bet's weighted stake to the player's lifetime wagered and moves them up the ladder.
   * Not idempotent on its own: call it only inside the wallet's debit transaction, below its
   * duplicate-bet guard, so a replayed bet never reaches it.
   */
  async recordWager(tx: DrizzleTx, args: WagerTrackingArgs) {
    if (moneyCompare(args.weightedAmount, '0') <= 0) {
      return;
    }
    const ladder = await tx
      .select({
        id: promoRankTier.id,
        position: promoRankTier.position,
        wagerThreshold: promoRankTier.wagerThreshold,
        currency: promoRankTier.currency,
      })
      .from(promoRankTier)
      .orderBy(asc(promoRankTier.position));
    const [lowest] = ladder;
    if (!lowest) {
      return;
    }
    const amount =
      args.currency === lowest.currency
        ? args.weightedAmount
        : await this.rates.convert(args.weightedAmount, args.currency, lowest.currency);
    if (amount === null) {
      // ponytail: a wager with no rate is not counted; store unconverted wagers and replay them if this shows up in logs
      this.logger.warn(
        {
          userId: args.userId,
          from: args.currency,
          to: lowest.currency,
          amount: args.weightedAmount,
        },
        'rank wager skipped - no exchange rate',
      );
      return;
    }

    const [rank] = await tx
      .insert(promoPlayerRank)
      .values({ userId: args.userId, currency: lowest.currency, lifetimeWagered: amount })
      .onConflictDoUpdate({
        target: promoPlayerRank.userId,
        set: {
          lifetimeWagered: sql`${promoPlayerRank.lifetimeWagered} + ${amount}::numeric`,
          updatedAt: sql`now()`,
        },
      })
      .returning({
        lifetimeWagered: promoPlayerRank.lifetimeWagered,
        tierId: promoPlayerRank.tierId,
      });
    const reached = rank && tierFor(ladder, rank.lifetimeWagered);
    const current = ladder.find((tier) => tier.id === rank?.tierId);
    if (!reached || (current && reached.position <= current.position)) {
      return;
    }
    await tx
      .update(promoPlayerRank)
      .set({ tierId: reached.id })
      .where(eq(promoPlayerRank.userId, args.userId));
  }

  async getForPlayer(userId: PromoPlayerRank['userId']) {
    const ladder = await this.drizzle.db
      .select({ ...TIER_COLUMNS, currency: promoRankTier.currency })
      .from(promoRankTier)
      .orderBy(asc(promoRankTier.position));
    const [lowest] = ladder;
    if (!lowest) {
      throw new RankLadderNotConfiguredError('default');
    }
    const [row] = await this.drizzle.db
      .select({ lifetimeWagered: promoPlayerRank.lifetimeWagered, tierId: promoPlayerRank.tierId })
      .from(promoPlayerRank)
      .where(eq(promoPlayerRank.userId, userId));
    const lifetimeWagered = row?.lifetimeWagered ?? '0';
    return {
      currency: lowest.currency,
      lifetimeWagered,
      tierId: row?.tierId ?? tierFor(ladder, lifetimeWagered)?.id ?? null,
      tiers: ladder.map(({ currency: _currency, ...tier }) => tier),
    };
  }
}
