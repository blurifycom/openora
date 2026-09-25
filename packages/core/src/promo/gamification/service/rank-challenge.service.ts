import { asc, desc, eq, gt, sql } from 'drizzle-orm';
import { user } from '@openora/core/pam/schema/identity';
import type {
  ExchangeRateReader,
  Uuid,
  WagerTrackingArgs,
  WagerTrackingCommands,
} from '@openora/core/contracts';
import { moneyCompare, type DrizzleService, type DrizzleTx } from '@openora/core/server';
import type {
  PlayerRankChallenge,
  RankChallengeLadder,
  RankChallengeTier,
} from '../contract/index.js';
import {
  promoRankChallengeClaim,
  promoRankChallengeTier,
  promoRankChallengeWager,
} from '../schema/index.js';

const TIER_COLUMNS = {
  id: promoRankChallengeTier.id,
  key: promoRankChallengeTier.key,
  name: promoRankChallengeTier.name,
  position: promoRankChallengeTier.position,
  wagerThreshold: promoRankChallengeTier.wagerThreshold,
  cashAmount: promoRankChallengeTier.cashAmount,
  physicalItem: promoRankChallengeTier.physicalItem,
};

/**
 * The Rank Challenge engine: a fifth `WAGER_TRACKING` consumer alongside `RankService`,
 * `RakebackService`, `StreakService` and `RaceService` - a race-to-threshold rather than a
 * repeating ladder or window. The FIRST player whose lifetime real-money wagering crosses a
 * tier's threshold wins it, once, forever; every other player who later crosses the same
 * threshold wins nothing.
 *
 * Own-money only, the same rule `RaceService` applies: `args.realAmount` already excludes
 * whatever part of a stake a bonus grant covered, so wagering a bonus never wins a prize funded
 * by the operator's own cash pool.
 *
 * Claiming happens here, inline in the same transaction every other `WAGER_TRACKING` consumer
 * runs in (below the wallet's duplicate-bet guard) - the atomic part is the unique index on
 * `promoRankChallengeClaim.tierId`, not the transaction boundary. Crediting the cash prize and
 * emitting the win event are deferred to `RankChallengePayoutService`, mirroring how
 * `promoRankLevelUp`/`promoStreakMilestoneGrant` settle out-of-band from the bet that earned
 * them - a domain event announced before its own commit could tell a player about a prize a
 * rolled-back transaction never granted.
 */
export class RankChallengeService implements WagerTrackingCommands {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly rates: ExchangeRateReader,
    private readonly logger: { warn: (context: object, message: string) => void },
  ) {}

  async recordWager(tx: DrizzleTx, args: WagerTrackingArgs) {
    if (moneyCompare(args.realAmount, '0') <= 0) {
      return;
    }
    const ladder = await tx
      .select(TIER_COLUMNS)
      .from(promoRankChallengeTier)
      .orderBy(asc(promoRankChallengeTier.position));
    const [lowest] = ladder;
    if (!lowest) {
      return;
    }
    const currency = await tx
      .select({ currency: promoRankChallengeTier.currency })
      .from(promoRankChallengeTier)
      .where(eq(promoRankChallengeTier.id, lowest.id));
    const ladderCurrency = currency[0]?.currency;
    if (!ladderCurrency) {
      return;
    }
    const amount =
      args.currency === ladderCurrency
        ? args.realAmount
        : await this.rates.convert(args.realAmount, args.currency, ladderCurrency);
    if (amount === null) {
      // ponytail: a wager with no rate is not counted toward the challenge; revisit if this
      // shows up in logs the way the equivalent race-side skip would.
      this.logger.warn(
        { userId: args.userId, from: args.currency, to: ladderCurrency },
        'rank challenge wager skipped - no exchange rate',
      );
      return;
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
      return;
    }

    const crossed = ladder.filter(
      (tier) => moneyCompare(tier.wagerThreshold, wager.lifetimeWagered) <= 0,
    );
    if (crossed.length === 0) {
      return;
    }
    const alreadyClaimed = await tx
      .select({ tierId: promoRankChallengeClaim.tierId })
      .from(promoRankChallengeClaim)
      .where(sql`${promoRankChallengeClaim.tierId} in ${crossed.map((t) => t.id)}`);
    const claimedIds = new Set(alreadyClaimed.map((c) => c.tierId));
    const contestable = crossed.filter((t) => !claimedIds.has(t.id));
    if (contestable.length === 0) {
      return;
    }

    for (const tier of contestable.sort((a, b) => a.position - b.position)) {
      // The claim guard: two concurrent transactions racing the same tier both attempt this
      // insert; the unique index on tierId lets exactly one land. `onConflictDoNothing` plus a
      // `.returning()` check (not a pre-check select) is what makes this race-safe - a
      // select-then-insert has a TOCTOU gap this does not.
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
      // Nothing to audit here beyond the claim row itself - RankChallengePayoutService carries
      // the AuditWritePort and records the settlement (cash credit, win event) once it runs,
      // the same split RankService uses between "rank changed" (recorded inline) and the
      // level-up bonus (settled later, audited by RankPayoutService's own caller).
      void won;
    }
  }

  /** The ladder's tiers alone - what `recordWager`/`getForPlayer` need, no winner join. */
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

  /** The ladder as an operator configured it, plus who has won each tier so far. Public. */
  async getLadder(): Promise<RankChallengeLadder> {
    const { currency, tiers } = await this.getTiers();
    const claims = await this.drizzle.db
      .select({
        tierId: promoRankChallengeClaim.tierId,
        userId: promoRankChallengeClaim.userId,
        username: user.username,
        claimedAt: promoRankChallengeClaim.claimedAt,
      })
      .from(promoRankChallengeClaim)
      .innerJoin(user, eq(user.id, promoRankChallengeClaim.userId));
    const byTier = new Map(claims.map((c) => [c.tierId, c]));
    return {
      currency,
      tiers: tiers.map((tier) => {
        const claim = byTier.get(tier.id);
        return {
          ...tier,
          winnerUserId: claim?.userId ?? null,
          winnerUsername: claim?.username ?? null,
          claimedAt: claim ? claim.claimedAt.toISOString() : null,
        };
      }),
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

    const top = await this.drizzle.db
      .select({
        userId: promoRankChallengeWager.userId,
        lifetimeWagered: promoRankChallengeWager.lifetimeWagered,
        username: user.username,
      })
      .from(promoRankChallengeWager)
      .innerJoin(user, eq(user.id, promoRankChallengeWager.userId))
      .orderBy(desc(promoRankChallengeWager.lifetimeWagered))
      .limit(5);

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
