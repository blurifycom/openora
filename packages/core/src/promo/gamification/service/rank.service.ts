import { and, asc, count, eq, inArray, sql } from 'drizzle-orm';
import type {
  AuditWritePort,
  ExchangeRateReader,
  RankPeriodicBasis,
  WagerReversalArgs,
  WagerTrackingArgs,
  WagerTrackingCommands,
  WagerTrackingWalletCredit,
} from '@openora/core/contracts';
import {
  houseEdge,
  makeNotFoundError,
  moneyCompare,
  moneyMultiplyDivide,
  moneySubtract,
  type DrizzleService,
  type DrizzleTx,
} from '@openora/core/server';
import type {
  PlayerRank,
  RankLadder,
  RankLookupEntry,
  RankPlayersEntry,
} from '../contract/index.js';
import { openPeriodKey, RANK_PERIOD_KINDS } from '../shared/rank-period.js';
import { TIER_COLUMNS, toLadder } from '../shared/rank-ladder.js';
import {
  promoPlayerRank,
  promoRankConfig,
  promoRankLevelUp,
  promoRankPeriodWager,
  promoRankRoundWager,
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

export class RankService implements WagerTrackingCommands {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly rates: ExchangeRateReader,
    private readonly audit: AuditWritePort,
    private readonly logger: { warn: (context: object, message: string) => void },
    private readonly periodicBasis: RankPeriodicBasis = 'flat',
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
  async recordWager(tx: DrizzleTx, args: WagerTrackingArgs): Promise<WagerTrackingWalletCredit[]> {
    if (moneyCompare(args.amount, '0') <= 0) {
      return [];
    }
    const [config] = await tx
      .select({
        eligibleProducts: promoRankConfig.eligibleProducts,
        payoutAnchors: promoRankConfig.payoutAnchors,
      })
      .from(promoRankConfig);
    if (!config) {
      return [];
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
      return [];
    }
    const eligible = countsToward(config.eligibleProducts, args.context.product);
    const amount = !eligible
      ? '0'
      : args.currency === lowest.currency
        ? args.amount
        : await this.rates.convert(args.amount, args.currency, lowest.currency, tx);
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
      return [];
    }

    // Counted under both periodic bases, so the counter is already full when an operator switches.
    const nativeMargin = eligible ? houseEdge(args.realAmount, args.context.rtp) : '0';
    const margin =
      args.currency === lowest.currency
        ? nativeMargin
        : moneyMultiplyDivide(amount, nativeMargin, args.amount);

    if (args.round && moneyCompare(args.realAmount, '0') > 0) {
      await tx
        .insert(promoRankRoundWager)
        .values({
          userId: args.userId,
          ...args.round,
          currency: args.currency,
          ladderCurrency: lowest.currency,
          stake: args.realAmount,
          margin,
        })
        .onConflictDoUpdate({
          target: [
            promoRankRoundWager.userId,
            promoRankRoundWager.providerName,
            promoRankRoundWager.currency,
            promoRankRoundWager.externalRoundId,
            promoRankRoundWager.ladderCurrency,
          ],
          set: {
            stake: sql`${promoRankRoundWager.stake} + ${args.realAmount}::numeric`,
            margin: sql`${promoRankRoundWager.margin} + ${margin}::numeric`,
          },
        });
    }
    if (!eligible) {
      return [];
    }

    // What the player wagered inside each open period, for the payouts that settle them. Upserted
    // per bet under the period's own key, so a bet placed after a period closed lands on the new
    // one and can never answer for the old.
    await tx
      .insert(promoRankPeriodWager)
      .values(
        RANK_PERIOD_KINDS.map((kind) => ({
          userId: args.userId,
          kind,
          periodKey: openPeriodKey(kind, new Date(), config.payoutAnchors),
          currency: lowest.currency,
          wagered: amount,
          margin,
        })),
      )
      .onConflictDoUpdate({
        target: [
          promoRankPeriodWager.userId,
          promoRankPeriodWager.kind,
          promoRankPeriodWager.periodKey,
        ],
        set: {
          wagered: sql`${promoRankPeriodWager.wagered} + ${amount}::numeric`,
          margin: sql`${promoRankPeriodWager.margin} + ${margin}::numeric`,
          updatedAt: sql`now()`,
        },
      });

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
      return [];
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
    return [];
  }

  /**
   * Takes a rolled-back bet's margin out of the open period counters, never below zero. Wagered
   * and lifetime wagered stay: a rank is never taken back. A rollback landing after its period
   * closed reduces the period now open instead.
   */
  async reverseWager(tx: DrizzleTx, args: WagerReversalArgs): Promise<void> {
    if (moneyCompare(args.realAmount, '0') <= 0) {
      return;
    }
    const [config] = await tx
      .select({ payoutAnchors: promoRankConfig.payoutAnchors })
      .from(promoRankConfig);
    if (!config) {
      return;
    }
    const rounds = await tx
      .select()
      .from(promoRankRoundWager)
      .where(
        and(
          eq(promoRankRoundWager.userId, args.userId),
          eq(promoRankRoundWager.providerName, args.round.providerName),
          eq(promoRankRoundWager.currency, args.currency),
          eq(promoRankRoundWager.externalRoundId, args.round.externalRoundId),
        ),
      )
      .orderBy(asc(promoRankRoundWager.ladderCurrency))
      .for('update');
    const now = new Date();
    let remaining = args.realAmount;
    for (const round of rounds) {
      if (moneyCompare(round.stake, '0') <= 0 || moneyCompare(remaining, '0') <= 0) {
        continue;
      }
      const stake = moneyCompare(remaining, round.stake) >= 0 ? round.stake : remaining;
      const margin = moneyMultiplyDivide(round.margin, stake, round.stake);
      remaining = moneySubtract(remaining, stake);
      if (moneyCompare(stake, round.stake) === 0) {
        await tx.delete(promoRankRoundWager).where(eq(promoRankRoundWager.id, round.id));
      } else {
        await tx
          .update(promoRankRoundWager)
          .set({
            stake: sql`${promoRankRoundWager.stake} - ${stake}::numeric`,
            margin: sql`${promoRankRoundWager.margin} - ${margin}::numeric`,
          })
          .where(eq(promoRankRoundWager.id, round.id));
      }
      if (moneyCompare(margin, '0') <= 0) {
        continue;
      }
      for (const kind of RANK_PERIOD_KINDS) {
        await tx
          .update(promoRankPeriodWager)
          .set({
            margin: sql`GREATEST(0, ${promoRankPeriodWager.margin} - ${margin}::numeric)`,
            updatedAt: sql`now()`,
          })
          .where(
            and(
              eq(promoRankPeriodWager.userId, args.userId),
              eq(promoRankPeriodWager.kind, kind),
              eq(promoRankPeriodWager.periodKey, openPeriodKey(kind, now, config.payoutAnchors)),
              eq(promoRankPeriodWager.currency, round.ladderCurrency),
            ),
          );
      }
    }
  }

  /** The ladder as an operator configured it. No player data, so anyone may read it. */
  async getLadder(): Promise<RankLadder> {
    const tiers = await this.drizzle.db
      .select({ ...TIER_COLUMNS, currency: promoRankTier.currency })
      .from(promoRankTier)
      .orderBy(asc(promoRankTier.position));
    const [lowest] = tiers;
    if (!lowest) {
      throw new RankLadderNotConfiguredError('default');
    }
    return toLadder(lowest.currency, tiers, this.periodicBasis);
  }

  /**
   * Public rank badges for a set of other players, one query, no N+1 - a chat avatar list or
   * friends panel looks these up batched for whoever is on screen. A user with no rank row yet,
   * or none held (tierId null), comes back with `tierKey`/`tierName` both null rather than
   * omitted, so a caller can tell "looked up, no rank" from "not in the response".
   *
   * There is no hidden-profile/ghost-mode setting anywhere in the platform today (checked pam
   * and social modules), so nothing here has one to respect.
   */
  async lookup(userIds: readonly PromoPlayerRank['userId'][]): Promise<RankLookupEntry[]> {
    if (userIds.length === 0) {
      return [];
    }
    const rows = await this.drizzle.db
      .select({
        userId: promoPlayerRank.userId,
        tierKey: promoRankTier.key,
        tierName: promoRankTier.name,
      })
      .from(promoPlayerRank)
      .leftJoin(promoRankTier, eq(promoRankTier.id, promoPlayerRank.tierId))
      .where(inArray(promoPlayerRank.userId, userIds));
    const byUser = new Map(rows.map((row) => [row.userId, row]));
    return userIds.map((userId) => {
      const row = byUser.get(userId);
      return { userId, tierKey: row?.tierKey ?? null, tierName: row?.tierName ?? null };
    });
  }

  /** How many players hold each tier right now, lowest tier first; a tier nobody holds is zero. */
  playersPerTier(): Promise<RankPlayersEntry[]> {
    return this.drizzle.db
      .select({ tierId: promoRankTier.id, players: count(promoPlayerRank.id) })
      .from(promoRankTier)
      .leftJoin(promoPlayerRank, eq(promoPlayerRank.tierId, promoRankTier.id))
      .groupBy(promoRankTier.id)
      .orderBy(asc(promoRankTier.position));
  }

  async getForPlayer(userId: PromoPlayerRank['userId']): Promise<PlayerRank> {
    const ladder = await this.getLadder();
    const [row] = await this.drizzle.db
      .select({ lifetimeWagered: promoPlayerRank.lifetimeWagered, tierId: promoPlayerRank.tierId })
      .from(promoPlayerRank)
      .where(eq(promoPlayerRank.userId, userId));
    const lifetimeWagered = row?.lifetimeWagered ?? '0';
    return {
      currency: ladder.currency,
      periodicBasis: ladder.periodicBasis,
      lifetimeWagered,
      tierId: row?.tierId ?? tierFor(ladder.tiers, lifetimeWagered)?.id ?? null,
      tiers: ladder.tiers,
    };
  }
}
