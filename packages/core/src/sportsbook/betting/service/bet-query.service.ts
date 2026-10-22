import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  lte,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { makeNotFoundError, pageToOffset, type DrizzleService } from '@openora/core/server';
import type { DateRange, IdentityReader, User, Uuid, WalletReader } from '@openora/core/contracts';
import type {
  AdminSportsbookBet,
  ListAdminSportsbookBetsInput,
  ListSportsbookBetsInput,
  SportsbookBet,
  SportsbookBetTransaction,
  SportsbookPlayerSummaryInput,
  SportsbookPromotionReportInput,
  SportsbookPromotionReportRow,
} from '../contract/index.js';
import { SPORTSBOOK_WALLET_PROVIDER_PREFIX } from '../contract/index.js';
import {
  sportsbookBet,
  sportsbookBetTransaction,
  type SportsbookBetRow,
  type SportsbookBetTransactionRow,
} from '../schema/index.js';
import { assertSportsbookPlayer } from './restriction.service.js';

export const SportsbookBetNotFoundError = makeNotFoundError('SportsbookBet');

function toBet(row: SportsbookBetRow): SportsbookBet {
  return {
    id: row.id,
    provider: row.provider,
    providerBetId: row.providerBetId,
    currency: row.currency,
    status: row.status,
    result: row.result,
    stake: row.stake,
    potentialPayout: row.potentialPayout,
    payoutTotal: row.payoutTotal,
    version: row.version,
    legs: row.legs,
    lastLegStartsAt: row.lastLegStartsAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    acceptedAt: row.acceptedAt?.toISOString() ?? null,
    settledAt: row.settledAt?.toISOString() ?? null,
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
  };
}

export function toAdminBet(row: SportsbookBetRow): AdminSportsbookBet {
  return {
    ...toBet(row),
    userId: row.userId,
    sessionId: row.sessionId,
    cashStake: row.cashStake,
    voidPayout: row.voidPayout,
    maxLossRefund: row.maxLossRefund,
    promotionType: row.promotionType,
    promotionId: row.promotionId,
    promotionFunder: row.promotionFunder,
    promotionPotential: row.promotionPotential,
    promotionPaid: row.promotionPaid,
  };
}

function toTransaction(row: SportsbookBetTransactionRow): SportsbookBetTransaction {
  return {
    id: row.id,
    providerTxId: row.providerTxId,
    kind: row.kind,
    amount: row.amount,
    potentialPayout: row.potentialPayout,
    legs: row.legs,
    promotionPotential: row.promotionPotential,
    betVersion: row.betVersion,
    result: row.result,
    cancelReason: row.cancelReason,
    promotionAmount: row.promotionAmount,
    walletTransactionIds: row.walletTransactionIds,
    balanceAfter: row.balanceAfter,
    createdAt: row.createdAt.toISOString(),
  };
}

function within(column: PgColumn, { dateFrom, dateTo }: DateRange) {
  return [
    ...(dateFrom ? [gte(column, new Date(dateFrom))] : []),
    ...(dateTo ? [lte(column, new Date(dateTo))] : []),
  ];
}

function sumOf(amount: SQL | PgColumn, where: SQL) {
  return sql<string>`coalesce(sum(${amount}) filter (where ${where}), 0)::numeric(38, 18)`;
}

export class SportsbookBetQueryService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly identity: IdentityReader,
    private readonly walletReader: WalletReader,
  ) {}

  async listOwn(userId: User['id'], input: ListSportsbookBetsInput) {
    const { items, ...page } = await this.list(input, [eq(sportsbookBet.userId, userId)]);
    return { ...page, items: items.map(toBet) };
  }

  async getOwn(userId: User['id'], id: SportsbookBet['id']): Promise<SportsbookBet> {
    const [row] = await this.drizzle.db
      .select()
      .from(sportsbookBet)
      .where(and(eq(sportsbookBet.id, id), eq(sportsbookBet.userId, userId)));
    if (!row) {
      throw new SportsbookBetNotFoundError(id);
    }
    return toBet(row);
  }

  async getOwnByTransaction(userId: User['id'], transactionId: Uuid): Promise<SportsbookBet> {
    const move = await this.walletReader.findOwnProviderTransaction?.(userId, transactionId);
    const provider = move?.providerName.startsWith(SPORTSBOOK_WALLET_PROVIDER_PREFIX)
      ? move.providerName.slice(SPORTSBOOK_WALLET_PROVIDER_PREFIX.length)
      : null;
    const [row] =
      provider && move?.externalRoundId
        ? await this.drizzle.db
            .select()
            .from(sportsbookBet)
            .where(
              and(
                eq(sportsbookBet.provider, provider),
                eq(sportsbookBet.providerBetId, move.externalRoundId),
                eq(sportsbookBet.userId, userId),
              ),
            )
        : [];
    if (!row) {
      throw new SportsbookBetNotFoundError(transactionId);
    }
    return toBet(row);
  }

  async adminList(input: ListAdminSportsbookBetsInput) {
    const filters: SQL[] = [];
    if (input.userId) {
      filters.push(eq(sportsbookBet.userId, input.userId));
    }
    if (input.provider) {
      filters.push(eq(sportsbookBet.provider, input.provider));
    }
    if (input.providerBetId) {
      filters.push(eq(sportsbookBet.providerBetId, input.providerBetId));
    }
    const { items, ...page } = await this.list(input, filters);
    return { ...page, items: items.map(toAdminBet) };
  }

  async adminGet(id: SportsbookBet['id']) {
    const [[row], transactions] = await Promise.all([
      this.drizzle.db.select().from(sportsbookBet).where(eq(sportsbookBet.id, id)),
      this.drizzle.db
        .select()
        .from(sportsbookBetTransaction)
        .where(eq(sportsbookBetTransaction.betId, id))
        .orderBy(asc(sportsbookBetTransaction.createdAt), asc(sportsbookBetTransaction.id)),
    ]);
    if (!row) {
      throw new SportsbookBetNotFoundError(id);
    }
    return { ...toAdminBet(row), transactions: transactions.map(toTransaction) };
  }

  /**
   * What promotions paid and reopens took back in the range, by type label and currency. It reads
   * the append-only transaction rows, so a later reopen never changes a closed period.
   */
  async promotionReport(
    range: SportsbookPromotionReportInput,
  ): Promise<SportsbookPromotionReportRow[]> {
    const tx = sportsbookBetTransaction;
    const partOf = (kind: 'settle' | 'reopen') => sumOf(tx.promotionAmount, eq(tx.kind, kind));
    return this.drizzle.db
      .select({
        type: sql<SportsbookPromotionReportRow['type']>`${sportsbookBet.promotionType}`,
        funder: sql<SportsbookPromotionReportRow['funder']>`${sportsbookBet.promotionFunder}`,
        currency: sportsbookBet.currency,
        bets: sql<number>`count(*) filter (where ${tx.kind} = 'settle')`.mapWith(Number),
        promotionPaid: partOf('settle'),
        promotionReversed: partOf('reopen'),
      })
      .from(tx)
      .innerJoin(sportsbookBet, eq(sportsbookBet.id, tx.betId))
      .where(
        and(
          gt(tx.promotionAmount, '0'),
          isNotNull(sportsbookBet.promotionType),
          ...within(tx.createdAt, range),
        ),
      )
      .groupBy(sportsbookBet.promotionType, sportsbookBet.promotionFunder, sportsbookBet.currency)
      .orderBy(
        asc(sportsbookBet.promotionType),
        asc(sportsbookBet.promotionFunder),
        asc(sportsbookBet.currency),
      );
  }

  async playerSummary({ userId, ...range }: SportsbookPlayerSummaryInput) {
    await assertSportsbookPlayer(this.identity, userId);
    const bet = sportsbookBet;
    const allOf = (conditions: SQL[]) => sql`(${sql.join(conditions, sql` and `)})`;
    const accepted = allOf([isNotNull(bet.acceptedAt), ...within(bet.acceptedAt, range)]);
    const reserved = allOf([eq(bet.status, 'reserved'), ...within(bet.createdAt, range)]);
    const staked = sql`(${accepted} or ${reserved})`;
    const settled = allOf([eq(bet.status, 'settled'), ...within(bet.settledAt, range)]);
    const open = inArray(bet.status, ['reserved', 'accepted']);
    return this.drizzle.db
      .select({
        currency: bet.currency,
        bets: sql<number>`count(*) filter (where ${staked})`.mapWith(Number),
        stake: sumOf(bet.stake, staked),
        cashStake: sumOf(bet.cashStake, staked),
        promotionStake: sumOf(sql`${bet.stake} - ${bet.cashStake}`, staked),
        payout: sumOf(bet.payoutTotal, settled),
        cashPayout: sumOf(sql`${bet.payoutTotal} - ${bet.promotionPaid}`, settled),
        promotionPayout: sumOf(bet.promotionPaid, settled),
        ggr: sql<string>`(${sumOf(bet.cashStake, staked)} - ${sumOf(bet.payoutTotal, settled)})::numeric(38, 18)`,
        openExposure: sumOf(bet.stake, open),
      })
      .from(bet)
      .where(and(eq(bet.userId, userId), or(staked, settled, open)))
      .groupBy(bet.currency)
      .orderBy(asc(bet.currency));
  }

  private async list({ page, limit, status }: ListSportsbookBetsInput, filters: SQL[]) {
    const where = and(...filters, status ? eq(sportsbookBet.status, status) : undefined);
    const [items, [{ total }]] = await Promise.all([
      this.drizzle.db
        .select()
        .from(sportsbookBet)
        .where(where)
        .orderBy(desc(sportsbookBet.createdAt), desc(sportsbookBet.id))
        .limit(limit)
        .offset(pageToOffset(page, limit)),
      this.drizzle.db.select({ total: count() }).from(sportsbookBet).where(where),
    ]);
    return { items, total: Number(total), page, limit };
  }
}
