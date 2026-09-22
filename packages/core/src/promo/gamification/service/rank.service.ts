import { asc, eq, sql } from 'drizzle-orm';
import type {
  AuditWritePort,
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
  promoRankConfig,
  promoRankLevelUp,
  promoRankTier,
  type PromoPlayerRank,
  type PromoRankTier,
} from '../schema/index.js';

export const RankLadderNotConfiguredError = makeNotFoundError('RankLadder');

type LadderRung = Pick<PromoRankTier, 'id' | 'position' | 'wagerThreshold'>;

const tierFor = <T extends LadderRung>(ladder: readonly T[], lifetime: string) =>
  ladder.filter((tier) => moneyCompare(tier.wagerThreshold, lifetime) <= 0).at(-1);

// An empty list counts every bet. A bet always names its product, so there is no third case.
const countsToward = (eligibleProducts: readonly string[], product: string) =>
  eligibleProducts.length === 0 || eligibleProducts.includes(product);

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
    private readonly audit: AuditWritePort,
    private readonly logger: { warn: (context: object, message: string) => void },
  ) {}

  /**
   * Adds a bet's stake to the player's lifetime wagered and moves them up the ladder, recording a
   * level-up bonus for every tier crossed for the payout job to settle.
   *
   * Counts the raw stake, not the bonus engine's weighted one: that weight comes from whichever
   * bonus the player holds, and a player's standing must not depend on it. What counts is decided
   * by the ladder's own `eligibleProducts`.
   *
   * Not idempotent on its own: call it only inside the wallet's debit transaction, below its
   * duplicate-bet guard, so a replayed bet never reaches it.
   */
  async recordWager(tx: DrizzleTx, args: WagerTrackingArgs) {
    if (moneyCompare(args.amount, '0') <= 0) {
      return;
    }
    const [config] = await tx
      .select({ eligibleProducts: promoRankConfig.eligibleProducts })
      .from(promoRankConfig);
    if (!config || !countsToward(config.eligibleProducts, args.context.product)) {
      return;
    }
    const ladder = await tx
      .select({
        id: promoRankTier.id,
        position: promoRankTier.position,
        wagerThreshold: promoRankTier.wagerThreshold,
        levelUpBonus: promoRankTier.levelUpBonus,
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
        ? args.amount
        : await this.rates.convert(args.amount, args.currency, lowest.currency);
    if (amount === null) {
      // ponytail: a wager with no rate is not counted; store unconverted wagers and replay them if this shows up in logs
      this.logger.warn(
        {
          userId: args.userId,
          from: args.currency,
          to: lowest.currency,
          amount: args.amount,
        },
        'rank wager skipped - no exchange rate',
      );
      return;
    }

    const [rank] = await tx
      .insert(promoPlayerRank)
      .values({
        userId: args.userId,
        currency: lowest.currency,
        lifetimeWagered: amount,
        lastWageredAt: sql`now()`,
      })
      .onConflictDoUpdate({
        target: promoPlayerRank.userId,
        set: {
          lifetimeWagered: sql`${promoPlayerRank.lifetimeWagered} + ${amount}::numeric`,
          lastWageredAt: sql`now()`,
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

    // Every tier crossed earns its bonus, not only the one landed on. The amount is taken now,
    // so one an admin fills in later is never paid backwards.
    const earned = ladder.flatMap((tier) =>
      tier.position > (current?.position ?? -1) &&
      tier.position <= reached.position &&
      tier.levelUpBonus !== null
        ? [
            {
              userId: args.userId,
              tierId: tier.id,
              currency: lowest.currency,
              amount: tier.levelUpBonus,
            },
          ]
        : [],
    );
    if (earned.length > 0) {
      await tx.insert(promoRankLevelUp).values(earned).onConflictDoNothing();
    }

    // The rank a player holds is audited; the wager that moved them is not. One row per bet would
    // bury every other player-state change in the log.
    await this.audit.recordInTransaction(tx, {
      actorType: 'system',
      action: 'promo.rank.changed',
      resourceType: 'promo_player_rank',
      resourceId: args.userId,
      before: { tierId: current?.id ?? null },
      after: { tierId: reached.id },
    });
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
