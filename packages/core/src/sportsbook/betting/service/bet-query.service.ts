import { and, asc, count, desc, eq, gt, gte, isNotNull, lte, sql, type SQL } from 'drizzle-orm';
import { makeNotFoundError, pageToOffset, type DrizzleService } from '@openora/core/server';
import type { User } from '@openora/core/contracts';
import type {
  AdminSportsbookBet,
  ListAdminSportsbookBetsInput,
  ListSportsbookBetsInput,
  SportsbookBet,
  SportsbookBetTransaction,
  SportsbookPromotionReportInput,
  SportsbookPromotionReportRow,
} from '../contract/index.js';
import {
  sportsbookBet,
  sportsbookBetTransaction,
  type SportsbookBetRow,
  type SportsbookBetTransactionRow,
} from '../schema/index.js';

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

export class SportsbookBetQueryService {
  constructor(private readonly drizzle: DrizzleService) {}

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
  async promotionReport({
    dateFrom,
    dateTo,
  }: SportsbookPromotionReportInput): Promise<SportsbookPromotionReportRow[]> {
    const tx = sportsbookBetTransaction;
    const partOf = (kind: 'settle' | 'reopen') =>
      sql<string>`coalesce(sum(${tx.promotionAmount}) filter (where ${tx.kind} = ${kind}), 0)::numeric(38, 18)`;
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
          dateFrom ? gte(tx.createdAt, new Date(dateFrom)) : undefined,
          dateTo ? lte(tx.createdAt, new Date(dateTo)) : undefined,
        ),
      )
      .groupBy(sportsbookBet.promotionType, sportsbookBet.promotionFunder, sportsbookBet.currency)
      .orderBy(
        asc(sportsbookBet.promotionType),
        asc(sportsbookBet.promotionFunder),
        asc(sportsbookBet.currency),
      );
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
