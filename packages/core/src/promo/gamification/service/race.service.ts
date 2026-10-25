import { and, asc, count, desc, eq, gt, isNull, lte, sql } from 'drizzle-orm';
import { player } from '@openora/core/pam/schema/profile';
import { user } from '@openora/core/pam/schema/identity';
import type {
  ExchangeRateReader,
  SettledWagerArgs,
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
import { RACE_COLUMNS, toRace } from '../shared/race-mapper.js';
import { roundReversal } from '../shared/round-reversal.js';

export const RaceNotFoundError = makeNotFoundError('Race');

// Counted when the bet settles, through recordSettledWager, so a reserve never climbs a race.
const SETTLED_PRODUCT = 'sportsbook';

const ROUND_KEY = [
  promoRaceRoundWager.raceId,
  promoRaceRoundWager.userId,
  promoRaceRoundWager.providerName,
  promoRaceRoundWager.currency,
  promoRaceRoundWager.externalRoundId,
];

type OpenRace = { id: string; currency: string; eligibleProducts: readonly string[] };

// Race-id order, the order reverseWager locks standings in.
const openRaceRows = (tx: DrizzleTx, at: Date) =>
  tx
    .select({
      id: promoRace.id,
      currency: promoRace.currency,
      eligibleProducts: promoRace.eligibleProducts,
    })
    .from(promoRace)
    .where(and(lte(promoRace.startAt, at), gt(promoRace.endAt, at), isNull(promoRace.closedAt)))
    .orderBy(asc(promoRace.id));

const countsProduct = (product: string) => (race: OpenRace) =>
  race.eligibleProducts.includes(product);

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
    if (args.context.product === SETTLED_PRODUCT || moneyCompare(args.realAmount, '0') <= 0) {
      return [];
    }
    for (const race of await this.openRaces(tx, new Date(), args.context.product)) {
      const amount = await this.inRaceCurrency(tx, args, race);
      if (amount === null) {
        continue;
      }
      await this.addToStanding(tx, race, args.userId, amount);
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
            target: ROUND_KEY,
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
   * Counts a sportsbook stake once, in the races open when the bet first settled other than void.
   * A round already standing in a race was counted there, so a re-settle after a reopen adds
   * nothing; a round a void took back to zero counts again.
   */
  async recordSettledWager(tx: DrizzleTx, args: SettledWagerArgs): Promise<void> {
    if (moneyCompare(args.realAmount, '0') <= 0) {
      return;
    }
    // Skips a race its payout is closing right now, so a closed race never changes.
    const open = await openRaceRows(tx, args.qualifiedAt).for('key share', { skipLocked: true });
    for (const race of open.filter(countsProduct(args.context.product))) {
      const [counted] = await tx
        .select({ stake: promoRaceRoundWager.stake })
        .from(promoRaceRoundWager)
        .where(
          and(
            eq(promoRaceRoundWager.raceId, race.id),
            eq(promoRaceRoundWager.userId, args.userId),
            eq(promoRaceRoundWager.providerName, args.round.providerName),
            eq(promoRaceRoundWager.currency, args.currency),
            eq(promoRaceRoundWager.externalRoundId, args.round.externalRoundId),
          ),
        )
        .for('update');
      if (counted && moneyCompare(counted.stake, '0') > 0) {
        continue;
      }
      const amount = await this.inRaceCurrency(tx, args, race);
      if (amount === null) {
        continue;
      }
      await this.addToStanding(tx, race, args.userId, amount);
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
          target: ROUND_KEY,
          set: { stake: args.realAmount, wagered: amount },
        });
    }
  }

  private async openRaces(tx: DrizzleTx, at: Date, product: string): Promise<OpenRace[]> {
    return (await openRaceRows(tx, at)).filter(countsProduct(product));
  }

  private async inRaceCurrency(
    tx: DrizzleTx,
    args: Pick<SettledWagerArgs, 'userId' | 'currency' | 'realAmount'>,
    race: OpenRace,
  ): Promise<string | null> {
    if (args.currency === race.currency) {
      return args.realAmount;
    }
    const amount = await this.rates.convert(args.realAmount, args.currency, race.currency, tx);
    if (amount === null) {
      // ponytail: a wager with no rate is not counted toward the race; revisit if this shows
      // up in logs the way the equivalent rank-side skip would.
      this.logger.warn(
        { userId: args.userId, raceId: race.id, from: args.currency, to: race.currency },
        'race wager skipped - no exchange rate',
      );
    }
    return amount;
  }

  private async addToStanding(
    tx: DrizzleTx,
    race: OpenRace,
    userId: SettledWagerArgs['userId'],
    amount: string,
  ): Promise<void> {
    await tx
      .insert(promoRaceWager)
      .values({ raceId: race.id, userId, currency: race.currency, wagered: amount })
      .onConflictDoUpdate({
        target: [promoRaceWager.raceId, promoRaceWager.userId],
        set: {
          wagered: sql`${promoRaceWager.wagered} + ${amount}::numeric`,
          updatedAt: sql`now()`,
        },
      });
  }

  // A void reaches reverseWager too when the bonus engine is loaded; the second call finds no stake left.
  async reverseSettledWager(tx: DrizzleTx, args: WagerReversalArgs): Promise<void> {
    await this.reverseWager(tx, args);
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
