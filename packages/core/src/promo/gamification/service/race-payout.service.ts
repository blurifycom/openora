import { and, asc, desc, eq, isNull, lte } from 'drizzle-orm';
import type {
  ExchangeRateReader,
  PlayEligibilityPort,
  Uuid,
  WalletCommands,
} from '@openora/core/contracts';
import type { DrizzleService, DrizzleTx } from '@openora/core/server';
import { promoRace, promoRacePayout, promoRaceWager } from '../schema/index.js';
import { priceForPayout } from '../shared/payout-currency.js';

/** What `plugin.ts` announces per winner, once its own settlement transaction has committed. */
export type RaceWon = {
  userId: Uuid;
  raceId: Uuid;
  raceName: string;
  position: number;
  /** As actually credited, after `priceForPayout` - may differ from the race's own currency. */
  amount: string;
  currency: string;
  /** Null on a replayed credit (the balance already moved and was already announced). */
  transactionId: string | null;
};

type Logger = {
  warn: (context: object, message: string) => void;
  error: (context: object, message: string) => void;
};

/**
 * Settles a race once its window has closed: freezes final standings, pays every position the
 * operator funded, and marks the race `closedAt` so it is never recomputed - the same "insert
 * once, skip if present" idempotency `RankPayoutService`/`StreakPayoutService` use for their own
 * settlement rows, guarded here by `promo_race_payout`'s `unique(raceId, userId)`.
 *
 * Races close at arbitrary configured timestamps rather than a shared daily/weekly/monthly
 * anchor, so this runs on a short recurring tick (see `plugin.ts`) instead of `RankPayoutAnchors`.
 *
 * A player under a responsible-gambling block is still ranked and still gets a payout row, so the
 * standings and history stay accurate - only the cash credit is withheld, the same rule
 * `RankPayoutService`/`StreakPayoutService` apply to their own grants.
 */
export class RacePayoutService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly eligibility: PlayEligibilityPort | undefined,
    private readonly wallet: WalletCommands | undefined,
    private readonly rates: ExchangeRateReader,
    private readonly payoutCurrency: string,
    private readonly logger: Logger,
  ) {}

  async closeDue(now: Date): Promise<RaceWon[]> {
    const due = await this.drizzle.db
      .select({ id: promoRace.id })
      .from(promoRace)
      .where(and(lte(promoRace.endAt, now), isNull(promoRace.closedAt)));

    const won: RaceWon[] = [];
    for (const { id } of due) {
      try {
        won.push(...(await this.drizzle.db.transaction((tx) => this.settleOne(tx, id, now))));
      } catch (err) {
        // One race's failure must not stop the next tick from settling the others due.
        this.logger.error({ err, raceId: id }, 'race settlement failed');
      }
    }
    return won;
  }

  private async settleOne(tx: DrizzleTx, raceId: Uuid, settledAt: Date): Promise<RaceWon[]> {
    const [race] = await tx
      .select({
        id: promoRace.id,
        name: promoRace.name,
        currency: promoRace.currency,
        positions: promoRace.positions,
        closedAt: promoRace.closedAt,
      })
      .from(promoRace)
      .where(eq(promoRace.id, raceId))
      .for('update', { skipLocked: true });
    if (!race || race.closedAt !== null) {
      return [];
    }

    const paidPositions = race.positions.length;
    const standings =
      paidPositions === 0
        ? []
        : await tx
            .select({ userId: promoRaceWager.userId, wagered: promoRaceWager.wagered })
            .from(promoRaceWager)
            .where(eq(promoRaceWager.raceId, raceId))
            // Tie-break: whoever's accumulator last moved at that total reached it first.
            .orderBy(desc(promoRaceWager.wagered), asc(promoRaceWager.updatedAt))
            .limit(paidPositions);

    const already = await tx
      .select({ userId: promoRacePayout.userId })
      .from(promoRacePayout)
      .where(eq(promoRacePayout.raceId, raceId));
    const settled = new Set(already.map((row) => row.userId));

    const won: RaceWon[] = [];
    for (const [index, standing] of standings.entries()) {
      if (settled.has(standing.userId)) {
        continue;
      }
      const position = race.positions[index];
      if (!position) {
        continue;
      }
      const restricted = (await this.eligibility?.isRestricted(standing.userId)) ?? true;
      if (restricted) {
        await tx.insert(promoRacePayout).values({
          raceId,
          userId: standing.userId,
          position: index + 1,
          amount: position.prize,
          currency: race.currency,
          grantId: null,
          outcome: 'restricted',
        });
        continue;
      }
      if (!this.wallet) {
        throw new Error('WALLET_COMMANDS is not bound');
      }
      // Never the race's own currency unconditionally - a crypto-only player must not have a
      // balance opened in whatever the prize pool is priced in. `priceForPayout` throws when no
      // rate is available; this whole settlement rolls back and the job's next tick retries it,
      // the same "not credited yet, retried later" rule a wallet credit failure follows below.
      const priced = await priceForPayout(
        this.rates,
        position.prize,
        race.currency,
        this.payoutCurrency,
      );
      const sourceRef = `race-payout:${raceId}:${standing.userId}`;
      const credited = await this.wallet.credit(tx, {
        userId: standing.userId,
        amount: priced.amount,
        currency: priced.currency,
        type: 'cashback',
        allowNewCurrency: true,
        providerRef: { providerName: 'promo-race', providerRefId: sourceRef },
      });
      if (!credited.ok) {
        // Thrown rather than logged-and-recorded-as-granted: a payout row must never claim
        // `outcome: 'granted'` for money that never moved. The whole race's settlement rolls
        // back and `closeDue`'s own catch retries it on the next tick.
        throw new Error(`race prize credit failed: ${credited.reason}`);
      }
      await tx.insert(promoRacePayout).values({
        raceId,
        userId: standing.userId,
        position: index + 1,
        amount: priced.amount,
        currency: priced.currency,
        grantId: null,
        outcome: 'granted',
      });
      won.push({
        userId: standing.userId,
        raceId,
        raceName: race.name,
        position: index + 1,
        amount: priced.amount,
        currency: priced.currency,
        transactionId: credited.moved ? credited.transactionId : null,
      });
    }

    await tx
      .update(promoRace)
      .set({ closedAt: settledAt, updatedAt: settledAt })
      .where(eq(promoRace.id, raceId));
    return won;
  }
}
