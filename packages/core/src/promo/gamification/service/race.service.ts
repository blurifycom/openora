import { leaderboardNamesOf } from '@openora/core/contracts';
import { and, asc, count, desc, eq, gt, isNull, lte, sql } from 'drizzle-orm';
import type {
  IdentityReader,
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

const SETTLED_PRODUCT = 'sportsbook';

const ROUND_KEY = [
  promoRaceRoundWager.raceId,
  promoRaceRoundWager.userId,
  promoRaceRoundWager.providerName,
  promoRaceRoundWager.currency,
  promoRaceRoundWager.externalRoundId,
];

type OpenRace = { id: string; currency: string; eligibleProducts: readonly string[] };

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

export function maskUsername(name: string): string {
  return `${name.slice(0, Math.min(3, name.length - 1))}****`;
}

export const RACE_STANDING_ORDER = [
  desc(promoRaceWager.wagered),
  asc(promoRaceWager.updatedAt),
  asc(promoRaceWager.userId),
];

const LEADERBOARD_CAP = 100;

export class RaceService implements WagerTrackingCommands {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly rates: ExchangeRateReader,
    private readonly logger: { warn: (context: object, message: string) => void },
    private readonly identity: IdentityReader,
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

  async recordSettledWager(
    tx: DrizzleTx,
    args: SettledWagerArgs,
  ): Promise<WagerTrackingWalletCredit[]> {
    if (moneyCompare(args.realAmount, '0') <= 0) {
      return [];
    }
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
    return [];
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

  async reverseSettledWager(tx: DrizzleTx, args: WagerReversalArgs): Promise<void> {
    await this.reverseWager(tx, args);
  }

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

    const [ranked, [counted]] = await Promise.all([
      this.drizzle.db
        .select({
          userId: promoRaceWager.userId,
          wagered: promoRaceWager.wagered,
        })
        .from(promoRaceWager)
        .where(eq(promoRaceWager.raceId, raceId))
        .orderBy(...RACE_STANDING_ORDER)
        .limit(LEADERBOARD_CAP),
      this.drizzle.db
        .select({ n: count() })
        .from(promoRaceWager)
        .where(eq(promoRaceWager.raceId, raceId)),
    ]);

    const names = await leaderboardNamesOf(
      this.identity,
      ranked.map((row) => row.userId),
    );
    const named = ranked.flatMap((row) => {
      const name = names.get(row.userId);
      return name ? [{ ...row, ...name }] : [];
    });
    const entries: RaceLeaderboardEntry[] = named.map((row, index) => ({
      userId: row.userId,
      username:
        row.userId === userId
          ? row.username
          : row.hideUsername
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
            amountToNextPaidPosition: amountToNextPaidPosition(
              race.positions.length,
              entries,
              ownIndex,
            ),
          };

    return {
      race,
      podium: entries.slice(0, 3),
      leaderboard: entries.slice(3),
      own,
      participants: Number(counted?.n ?? 0),
    };
  }
}

export function amountToNextPaidPosition(
  paidPositions: number,
  entries: readonly RaceLeaderboardEntry[],
  ownIndex: number,
): string | null {
  if (paidPositions === 0 || ownIndex < paidPositions) {
    return null;
  }
  const lastPaid = entries[paidPositions - 1];
  const ownEntry = entries[ownIndex];
  if (!lastPaid || !ownEntry) {
    return null;
  }
  return moneyCompare(lastPaid.wagered, ownEntry.wagered) <= 0
    ? '0'
    : moneySubtract(lastPaid.wagered, ownEntry.wagered);
}
