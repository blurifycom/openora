import { and, asc, count, desc, eq, gt, isNull, lte, sql } from 'drizzle-orm';
import { player } from '@openora/core/pam/schema/profile';
import { user } from '@openora/core/pam/schema/identity';
import type {
  ExchangeRateReader,
  Uuid,
  WagerReversalArgs,
  WagerTrackingArgs,
  WagerTrackingCommands,
  WagerTrackingWalletCredit,
} from '@openora/core/contracts';
import {
  makeNotFoundError,
  moneyCompare,
  moneySubtract,
  type DrizzleService,
  type DrizzleTx,
} from '@openora/core/server';
import type { Race, RaceForPlayer, RaceLeaderboardEntry } from '../contract/index.js';
import { promoRace, promoRaceRoundWager, promoRaceWager } from '../schema/index.js';
import { roundReversal } from '../shared/round-reversal.js';

export const RaceNotFoundError = makeNotFoundError('Race');

// An empty list counts every bet - the same convention RankService/StreakService use.
const countsToward = (eligibleProducts: readonly string[], product: string) =>
  eligibleProducts.length === 0 || eligibleProducts.includes(product);

const INCOGNITO = 'Incognito';

/**
 * The server-side source of truth for a masked leaderboard username, so a client's own copy of
 * this rule (if it has one) never disagrees with what the payload already carries - a leaderboard
 * response reflects masking itself rather than leaving it to be applied client-side. A fixed
 * suffix, so the mask never tells how long the hidden part is.
 */
function maskUsername(name: string): string {
  return `${name.slice(0, Math.min(3, name.length - 1))}****`;
}

/**
 * Standings order, shared by the board and the payout so the player shown in a place is the one
 * paid for it. Ties go to whoever's total last moved earliest - who reached it first - and then
 * to the user id, so even an exact tie on both has one answer.
 */
export const RACE_STANDING_ORDER = [
  desc(promoRaceWager.wagered),
  asc(promoRaceWager.updatedAt),
  asc(promoRaceWager.userId),
];

const RACE_COLUMNS = {
  id: promoRace.id,
  name: promoRace.name,
  currency: promoRace.currency,
  startAt: promoRace.startAt,
  endAt: promoRace.endAt,
  prizePool: promoRace.prizePool,
  positions: promoRace.positions,
  eligibleProducts: promoRace.eligibleProducts,
  closedAt: promoRace.closedAt,
  createdAt: promoRace.createdAt,
  updatedAt: promoRace.updatedAt,
};

const toRace = (row: {
  id: string;
  name: string;
  currency: string;
  startAt: Date;
  endAt: Date;
  prizePool: string;
  positions: Race['positions'];
  eligibleProducts: string[];
  closedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): Race => ({
  id: row.id,
  name: row.name,
  currency: row.currency,
  startAt: row.startAt.toISOString(),
  endAt: row.endAt.toISOString(),
  prizePool: row.prizePool,
  positions: row.positions,
  eligibleProducts: row.eligibleProducts,
  closedAt: row.closedAt ? row.closedAt.toISOString() : null,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

const LEADERBOARD_CAP = 100;

/**
 * The wager-challenge / leaderboard-race engine: a fourth `WAGER_TRACKING` consumer alongside
 * `RankService`, `RakebackService` and `StreakService`, plus the player-facing reads the race
 * page renders from.
 *
 * Own-money only, the same rule `RakebackService` applies: `args.realAmount` already excludes
 * whatever part of a stake a bonus grant covered, so wagering a bonus never climbs a race whose
 * prize is real cash.
 */
export class RaceService implements WagerTrackingCommands {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly rates: ExchangeRateReader,
    private readonly logger: { warn: (context: object, message: string) => void },
  ) {}

  async recordWager(tx: DrizzleTx, args: WagerTrackingArgs): Promise<WagerTrackingWalletCredit[]> {
    if (moneyCompare(args.realAmount, '0') <= 0) {
      return [];
    }
    const now = new Date();
    const open = await tx
      .select({
        id: promoRace.id,
        currency: promoRace.currency,
        eligibleProducts: promoRace.eligibleProducts,
      })
      .from(promoRace)
      .where(
        and(lte(promoRace.startAt, now), gt(promoRace.endAt, now), isNull(promoRace.closedAt)),
      );

    for (const race of open) {
      if (!countsToward(race.eligibleProducts, args.context.product)) {
        continue;
      }
      const amount =
        args.currency === race.currency
          ? args.realAmount
          : await this.rates.convert(args.realAmount, args.currency, race.currency);
      if (amount === null) {
        // ponytail: a wager with no rate is not counted toward the race; revisit if this shows
        // up in logs the way the equivalent rank-side skip would.
        this.logger.warn(
          { userId: args.userId, raceId: race.id, from: args.currency, to: race.currency },
          'race wager skipped - no exchange rate',
        );
        continue;
      }
      await tx
        .insert(promoRaceWager)
        .values({ raceId: race.id, userId: args.userId, currency: race.currency, wagered: amount })
        .onConflictDoUpdate({
          target: [promoRaceWager.raceId, promoRaceWager.userId],
          set: {
            wagered: sql`${promoRaceWager.wagered} + ${amount}::numeric`,
            updatedAt: sql`now()`,
          },
        });
      if (args.round) {
        await tx
          .insert(promoRaceRoundWager)
          .values({
            raceId: race.id,
            userId: args.userId,
            providerName: args.round.providerName,
            currency: args.currency,
            externalRoundId: args.round.externalRoundId,
            stake: args.realAmount,
            wagered: amount,
          })
          .onConflictDoUpdate({
            target: [
              promoRaceRoundWager.raceId,
              promoRaceRoundWager.userId,
              promoRaceRoundWager.providerName,
              promoRaceRoundWager.currency,
              promoRaceRoundWager.externalRoundId,
            ],
            set: {
              stake: sql`${promoRaceRoundWager.stake} + ${args.realAmount}::numeric`,
              wagered: sql`${promoRaceRoundWager.wagered} + ${amount}::numeric`,
            },
          });
      }
    }
    return [];
  }

  /**
   * Takes a rolled-back stake back out of every race the round counted in and that has not closed
   * yet - a closed race's standings are frozen and already paid. Each race takes back its own
   * share of the reversed stake, independently: one round counts in full in every race it was
   * eligible for, so it is reversed in full in each of them too.
   */
  async reverseWager(tx: DrizzleTx, args: WagerReversalArgs): Promise<void> {
    const rounds = await tx
      .select({
        id: promoRaceRoundWager.id,
        raceId: promoRaceRoundWager.raceId,
        stake: promoRaceRoundWager.stake,
        wagered: promoRaceRoundWager.wagered,
      })
      .from(promoRaceRoundWager)
      .innerJoin(promoRace, eq(promoRace.id, promoRaceRoundWager.raceId))
      .where(
        and(
          eq(promoRaceRoundWager.userId, args.userId),
          eq(promoRaceRoundWager.providerName, args.round.providerName),
          eq(promoRaceRoundWager.currency, args.currency),
          eq(promoRaceRoundWager.externalRoundId, args.round.externalRoundId),
          gt(promoRaceRoundWager.stake, '0'),
          isNull(promoRace.closedAt),
        ),
      )
      .orderBy(asc(promoRaceRoundWager.raceId))
      .for('update', { of: promoRaceRoundWager });

    for (const round of rounds) {
      const reversed = roundReversal(round, args.realAmount);
      await tx
        .update(promoRaceRoundWager)
        .set({
          stake: sql`${promoRaceRoundWager.stake} - ${reversed.stake}::numeric`,
          wagered: sql`${promoRaceRoundWager.wagered} - ${reversed.wagered}::numeric`,
        })
        .where(eq(promoRaceRoundWager.id, round.id));
      await tx
        .update(promoRaceWager)
        .set({
          wagered: sql`GREATEST(0, ${promoRaceWager.wagered} - ${reversed.wagered}::numeric)`,
          updatedAt: sql`now()`,
        })
        .where(
          and(eq(promoRaceWager.raceId, round.raceId), eq(promoRaceWager.userId, args.userId)),
        );
    }
  }

  async listActive(now: Date): Promise<Race[]> {
    const rows = await this.drizzle.db
      .select(RACE_COLUMNS)
      .from(promoRace)
      .where(and(lte(promoRace.startAt, now), gt(promoRace.endAt, now), isNull(promoRace.closedAt)))
      .orderBy(asc(promoRace.endAt));
    return rows.map(toRace);
  }

  async getForPlayer(raceId: Uuid, userId: Uuid): Promise<RaceForPlayer> {
    const [row] = await this.drizzle.db
      .select(RACE_COLUMNS)
      .from(promoRace)
      .where(eq(promoRace.id, raceId));
    if (!row) {
      throw new RaceNotFoundError(raceId);
    }
    const race = toRace(row);

    // One capped query, ranked by wagered desc - a page size of 100 is enough for a paid/ranked
    // leaderboard; add real pagination if a race ever needs more than that (ponytail).
    const [ranked, [counted]] = await Promise.all([
      this.drizzle.db
        .select({
          userId: promoRaceWager.userId,
          wagered: promoRaceWager.wagered,
          username: user.username,
          hideUsername: player.hideUsernameOnLeaderboards,
        })
        .from(promoRaceWager)
        .innerJoin(user, eq(user.id, promoRaceWager.userId))
        .leftJoin(player, eq(player.userId, promoRaceWager.userId))
        .where(eq(promoRaceWager.raceId, raceId))
        .orderBy(...RACE_STANDING_ORDER)
        .limit(LEADERBOARD_CAP),
      // Served by the (raceId, ...) indexes alone; one row per player per race.
      this.drizzle.db
        .select({ n: count() })
        .from(promoRaceWager)
        .where(eq(promoRaceWager.raceId, raceId)),
    ]);

    const entries: RaceLeaderboardEntry[] = ranked.map((row, index) => ({
      userId: row.userId,
      username:
        row.userId === userId
          ? row.username
          : (row.hideUsername ?? false)
            ? INCOGNITO
            : maskUsername(row.username),
      wagered: row.wagered,
      position: index + 1,
    }));

    const ownIndex = entries.findIndex((entry) => entry.userId === userId);
    const ownEntry = ownIndex === -1 ? null : entries[ownIndex];
    const own =
      ownEntry === null || ownEntry === undefined
        ? { userId, wagered: '0', position: null, amountToNextPaidPosition: null }
        : {
            userId,
            wagered: ownEntry.wagered,
            position: ownEntry.position,
            amountToNextPaidPosition: this.amountToNextPaidPosition(race, entries, ownIndex),
          };

    return {
      race,
      podium: entries.slice(0, 3),
      leaderboard: entries.slice(3),
      own,
      participants: Number(counted?.n ?? 0),
    };
  }

  /**
   * How much more the player must wager to reach the next-better paid position - the wagered
   * amount of whoever currently holds it, minus the player's own. Null once the player already
   * holds a paid position, or the race pays no positions at all.
   */
  private amountToNextPaidPosition(
    race: Race,
    entries: readonly RaceLeaderboardEntry[],
    ownIndex: number,
  ): string | null {
    const paidPositions = race.positions.length;
    if (paidPositions === 0 || ownIndex < paidPositions) {
      return null;
    }
    const nextBetter = entries[paidPositions - 1];
    const ownEntry = entries[ownIndex];
    if (!nextBetter || !ownEntry) {
      return null;
    }
    const own = ownEntry.wagered;
    return moneyCompare(nextBetter.wagered, own) <= 0
      ? '0'
      : moneySubtract(nextBetter.wagered, own);
  }
}
