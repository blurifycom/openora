import { asc, desc, eq, gt, sql } from 'drizzle-orm';
import type {
  IdentityReader,
  ExchangeRateReader,
  Uuid,
  WagerTrackingArgs,
  WagerTrackingCommands,
  WagerTrackingWalletCredit,
} from '@openora/core/contracts';
import { moneyCompare, type DrizzleService, type DrizzleTx } from '@openora/core/server';
import type {
  PlayerRankChallenge,
  RankChallengeLadder,
  RankChallengeTier,
} from '../contract/index.js';
import { DEFAULT_RANK_PERK_PRODUCTS } from '../contract/index.js';
import {
  promoRankChallengeClaim,
  promoRankChallengeTier,
  promoRankChallengeWager,
  promoRankConfig,
} from '../schema/index.js';
import {
  nameWinners,
  TIER_COLUMNS,
  withUsernames,
  withWinners,
} from '../shared/rank-challenge-ladder.js';

export class RankChallengeService implements WagerTrackingCommands {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly rates: ExchangeRateReader,
    private readonly logger: { warn: (context: object, message: string) => void },
    private readonly identity: IdentityReader,
  ) {}

  async recordWager(tx: DrizzleTx, args: WagerTrackingArgs): Promise<WagerTrackingWalletCredit[]> {
    if (moneyCompare(args.realAmount, '0') <= 0) {
      return [];
    }
    const products = promoRankConfig.rankChallengeEligibleProducts;
    const product = args.context.product;
    const challengeCountsProduct = sql`coalesce(
      (select cardinality(${products}) = 0 or ${product} = any(${products})
        from ${promoRankConfig} where ${promoRankConfig.singletonKey} = 'global'),
      ${DEFAULT_RANK_PERK_PRODUCTS.some((p) => p === product)}::boolean
    )`;
    const ladder = await tx
      .select(TIER_COLUMNS)
      .from(promoRankChallengeTier)
      .where(challengeCountsProduct)
      .orderBy(asc(promoRankChallengeTier.position));
    const [lowest] = ladder;
    if (!lowest) {
      return [];
    }
    const currency = await tx
      .select({ currency: promoRankChallengeTier.currency })
      .from(promoRankChallengeTier)
      .where(eq(promoRankChallengeTier.id, lowest.id));
    const ladderCurrency = currency[0]?.currency;
    if (!ladderCurrency) {
      return [];
    }
    const amount =
      args.currency === ladderCurrency
        ? args.realAmount
        : await this.rates.convert(args.realAmount, args.currency, ladderCurrency, tx);
    if (amount === null) {
      this.logger.warn(
        { userId: args.userId, from: args.currency, to: ladderCurrency },
        'rank challenge wager skipped - no exchange rate',
      );
      return [];
    }

    const [wager] = await tx
      .insert(promoRankChallengeWager)
      .values({ userId: args.userId, currency: ladderCurrency, lifetimeWagered: amount })
      .onConflictDoUpdate({
        target: promoRankChallengeWager.userId,
        set: {
          lifetimeWagered: sql`${promoRankChallengeWager.lifetimeWagered} + ${amount}::numeric`,
          updatedAt: sql`now()`,
        },
      })
      .returning({ lifetimeWagered: promoRankChallengeWager.lifetimeWagered });
    if (!wager) {
      return [];
    }

    const crossed = ladder.filter(
      (tier) => moneyCompare(tier.wagerThreshold, wager.lifetimeWagered) <= 0,
    );
    if (crossed.length === 0) {
      return [];
    }
    const alreadyClaimed = await tx
      .select({ tierId: promoRankChallengeClaim.tierId })
      .from(promoRankChallengeClaim)
      .where(sql`${promoRankChallengeClaim.tierId} in ${crossed.map((t) => t.id)}`);
    const claimedIds = new Set(alreadyClaimed.map((c) => c.tierId));
    const contestable = crossed.filter((t) => !claimedIds.has(t.id));
    if (contestable.length === 0) {
      return [];
    }

    for (const tier of contestable.sort((a, b) => a.position - b.position)) {
      const [won] = await tx
        .insert(promoRankChallengeClaim)
        .values({
          tierId: tier.id,
          userId: args.userId,
          currency: ladderCurrency,
          cashAmount: tier.cashAmount,
          physicalItem: tier.physicalItem,
        })
        .onConflictDoNothing({ target: promoRankChallengeClaim.tierId })
        .returning({ id: promoRankChallengeClaim.id });
      void won;
    }
    return [];
  }

  private async getTiers(): Promise<{ currency: string; tiers: RankChallengeTier[] }> {
    const tiers = await this.drizzle.db
      .select({ ...TIER_COLUMNS, currency: promoRankChallengeTier.currency })
      .from(promoRankChallengeTier)
      .orderBy(asc(promoRankChallengeTier.position));
    const [lowest] = tiers;
    return {
      currency: lowest?.currency ?? 'USD',
      tiers: tiers.map(({ currency: _currency, ...tier }) => tier),
    };
  }

  async getLadder(): Promise<RankChallengeLadder> {
    const { currency, tiers } = await this.getTiers();
    return {
      currency,
      tiers: await nameWinners(this.identity, await withWinners(this.drizzle.db, tiers)),
    };
  }

  async getForPlayer(userId: Uuid): Promise<PlayerRankChallenge> {
    const ladder = await this.getTiers();
    const claims = await this.drizzle.db
      .select({ tierId: promoRankChallengeClaim.tierId })
      .from(promoRankChallengeClaim);
    const claimedIds = new Set(claims.map((c) => c.tierId));
    const nextTier = ladder.tiers.find((t) => !claimedIds.has(t.id)) ?? null;

    const [row] = await this.drizzle.db
      .select({ lifetimeWagered: promoRankChallengeWager.lifetimeWagered })
      .from(promoRankChallengeWager)
      .where(eq(promoRankChallengeWager.userId, userId));
    const lifetimeWagered = row?.lifetimeWagered ?? '0';

    const top = await withUsernames(
      this.identity,
      await this.drizzle.db
        .select({
          userId: promoRankChallengeWager.userId,
          lifetimeWagered: promoRankChallengeWager.lifetimeWagered,
        })
        .from(promoRankChallengeWager)
        .orderBy(desc(promoRankChallengeWager.lifetimeWagered))
        .limit(5),
    );

    const leaderboard = top.map((r, index) => ({
      userId: r.userId,
      username: r.username,
      lifetimeWagered: r.lifetimeWagered,
      position: index + 1,
    }));

    const ownIndex = leaderboard.findIndex((e) => e.userId === userId);
    let ownPosition: number | null = ownIndex === -1 ? null : ownIndex + 1;
    if (ownPosition === null && moneyCompare(lifetimeWagered, '0') > 0) {
      const [{ count }] = await this.drizzle.db
        .select({ count: sql<number>`count(*)::int` })
        .from(promoRankChallengeWager)
        .where(gt(promoRankChallengeWager.lifetimeWagered, lifetimeWagered));
      ownPosition = (count ?? 0) + 1;
    }

    return {
      currency: ladder.currency,
      lifetimeWagered,
      nextTier,
      leaderboard,
      ownPosition,
    };
  }
}
