import { and, asc, count, desc, eq, type SQL } from 'drizzle-orm';
import { makeNotFoundError, pageToOffset, type DrizzleService } from '@openora/core/server';
import type { User } from '@openora/core/contracts';
import type {
  AdminSportsbookBet,
  ListAdminSportsbookBetsInput,
  ListSportsbookBetsInput,
  SportsbookBet,
  SportsbookBetTransaction,
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
  return { ...toBet(row), userId: row.userId, sessionId: row.sessionId };
}

function toTransaction(row: SportsbookBetTransactionRow): SportsbookBetTransaction {
  return {
    id: row.id,
    providerTxId: row.providerTxId,
    kind: row.kind,
    amount: row.amount,
    potentialPayout: row.potentialPayout,
    legs: row.legs,
    betVersion: row.betVersion,
    result: row.result,
    cancelReason: row.cancelReason,
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
