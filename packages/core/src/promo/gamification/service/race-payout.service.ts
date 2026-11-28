import { and, eq, isNull, lte } from 'drizzle-orm';
import type {
  IdentityReader,
  AuditWritePort,
  ExchangeRateReader,
  PlayEligibilityPort,
  Uuid,
  WalletCommands,
} from '@openora/core/contracts';
import type { DrizzleService, DrizzleTx, EventBus } from '@openora/core/server';
import {
  promoRace,
  promoRacePayout,
  promoRaceRoundWager,
  promoRaceWager,
} from '../schema/index.js';
import { announceCashCredit } from '../shared/cash-credit-event.js';
import { priceForPayout } from '../shared/payout-currency.js';
import { RACE_STANDING_ORDER } from './race.service.js';

export type RaceWon = {
  userId: Uuid;
  raceId: Uuid;
  raceName: string;
  position: number;
  amount: string;
  currency: string;
  transactionId: string | null;
};

type AuditEntry = Parameters<AuditWritePort['record']>[0];

type PayoutSettled = Pick<
  RaceWon,
  'userId' | 'position' | 'amount' | 'currency' | 'transactionId'
> & { outcome: 'granted' | 'restricted' };

const payoutAudit = (raceId: Uuid, settled: PayoutSettled): AuditEntry => ({
  actorType: 'system',
  action: 'promo.race.payout.settled',
  resourceType: 'promo_race',
  resourceId: raceId,
  before: { settledAt: null },
  after: settled,
});

export const STUCK_AFTER_FAILURES = 5;

type Logger = {
  warn: (context: object, message: string) => void;
  error: (context: object, message: string) => void;
};

export type RacePayoutDeps = {
  drizzle: DrizzleService;
  eligibility: PlayEligibilityPort | undefined;
  wallet: WalletCommands | undefined;
  rates: ExchangeRateReader;
  payoutCurrency: string;
  audit: AuditWritePort;
  events: EventBus;
  logger: Logger;
  identity: IdentityReader;
};

export class RacePayoutService {
  private readonly failures = new Map<Uuid, number>();

  constructor(private readonly deps: RacePayoutDeps) {}

  async closeDue(now: Date): Promise<RaceWon[]> {
    const due = await this.deps.drizzle.db
      .select({ id: promoRace.id })
      .from(promoRace)
      .where(and(lte(promoRace.endAt, now), isNull(promoRace.closedAt)));

    const won: RaceWon[] = [];
    for (const { id } of due) {
      try {
        won.push(...(await this.deps.drizzle.db.transaction((tx) => this.settleOne(tx, id, now))));
        this.failures.delete(id);
      } catch (err) {
        const failures = (this.failures.get(id) ?? 0) + 1;
        this.failures.set(id, failures);
        this.deps.logger.error({ err, raceId: id, failures }, 'race settlement failed');
        if (failures >= STUCK_AFTER_FAILURES) {
          this.deps.logger.error({ raceId: id, failures }, 'race settlement stuck');
        }
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
            .orderBy(...RACE_STANDING_ORDER)
            .limit(paidPositions);

    const already = await tx
      .select({ userId: promoRacePayout.userId })
      .from(promoRacePayout)
      .where(eq(promoRacePayout.raceId, raceId));
    const settled = new Set(already.map((row) => row.userId));

    const won: RaceWon[] = [];
    const audits: AuditEntry[] = [];
    for (const [index, standing] of standings.entries()) {
      if (settled.has(standing.userId)) {
        continue;
      }
      const position = race.positions[index];
      if (!position) {
        continue;
      }
      const restricted = (await this.deps.eligibility?.isRestricted(standing.userId, tx)) ?? true;
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
        audits.push(
          payoutAudit(raceId, {
            userId: standing.userId,
            position: index + 1,
            amount: position.prize,
            currency: race.currency,
            outcome: 'restricted',
            transactionId: null,
          }),
        );
        continue;
      }
      if (!this.deps.wallet) {
        throw new Error('WALLET_COMMANDS is not bound');
      }
      const priced = await priceForPayout(
        tx,
        this.deps.rates,
        position.prize,
        race.currency,
        this.deps.payoutCurrency,
      );
      const sourceRef = `race-payout:${raceId}:${standing.userId}`;
      const credited = await this.deps.wallet.credit(tx, {
        userId: standing.userId,
        amount: priced.amount,
        currency: priced.currency,
        type: 'cashback',
        allowNewCurrency: true,
        allowNewWallet: true,
        providerRef: { providerName: 'promo-race', providerRefId: sourceRef },
      });
      if (!credited.ok) {
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
      const transactionId = credited.moved ? credited.transactionId : null;
      audits.push(
        payoutAudit(raceId, {
          userId: standing.userId,
          position: index + 1,
          amount: priced.amount,
          currency: priced.currency,
          outcome: 'granted',
          transactionId,
        }),
      );
      won.push({
        userId: standing.userId,
        raceId,
        raceName: race.name,
        position: index + 1,
        amount: priced.amount,
        currency: priced.currency,
        transactionId,
      });
    }

    await tx
      .update(promoRace)
      .set({ closedAt: settledAt, updatedAt: settledAt })
      .where(eq(promoRace.id, raceId));
    await this.deps.audit.recordManyInTransaction(tx, audits);
    for (const win of won) {
      await this.deps.events.emitInTransaction(tx, 'promo.race.won', win);
      await announceCashCredit(tx, this.deps, win);
    }
    await tx.delete(promoRaceRoundWager).where(eq(promoRaceRoundWager.raceId, raceId));
    return won;
  }
}
