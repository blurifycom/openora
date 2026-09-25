import { and, asc, desc, eq, gt, isNull, lte, sql } from 'drizzle-orm';
import { player } from '@openora/core/pam/schema/profile';
import { user } from '@openora/core/pam/schema/identity';
import type {
  ExchangeRateReader,
  Uuid,
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
import { promoRace, promoRaceWager } from '../schema/index.js';

export const RaceNotFoundError = makeNotFoundError('Race');

// An empty list counts every bet - the same convention RankService/StreakService use.
const countsToward = (eligibleProducts: readonly string[], product: string) =>
  eligibleProducts.length === 0 || eligibleProducts.includes(product);

const INCOGNITO = 'Incognito';

/**
 * The server-side source of truth for a masked leaderboard username, so a client's own copy of
 * this rule (if it has one) never disagrees with what the payload already carries - a leaderboard
 * response reflects masking itself rather than leaving it to be applied client-side.
 */
function maskUsername(name: string): string {
  const visible = Math.min(3, Math.max(1, Math.floor(name.length / 3)));
  return `${name.slice(0, visible)}${'*'.repeat(Math.max(4, name.length - visible + 4))}`;
}

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
    }
    return [];
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
    const ranked = await this.drizzle.db
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
      .orderBy(desc(promoRaceWager.wagered))
      .limit(LEADERBOARD_CAP);

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
