import { and, count, eq, gte, inArray, lte, sql, type SQL } from 'drizzle-orm';
import type { DrizzleService } from '@openora/core/server';
import { dayRangeInstants } from '@openora/core/contracts';
import { player } from '@openora/core/pam/schema/profile';
import {
  resolveTransactionsFindRange,
  type TransactionsFind,
  type TransactionsFindInput,
  type TransactionsFindSortBy,
} from '../contract/index.js';
import { wallet, walletTransaction } from '../schema/index.js';

const tx = walletTransaction;

const SORT_COLUMNS: Record<TransactionsFindSortBy, SQL> = {
  createdAt: sql`${tx.createdAt}`,
  amount: sql`${tx.amount}`,
};

/**
 * Finds wallet transactions across all players, each by player id. Reads the ledger columns only:
 * no address, hash, provider reference or review note.
 */
export class TransactionsFindService {
  constructor(private readonly drizzle: DrizzleService) {}

  async find(
    {
      type,
      status,
      playerId,
      currency,
      minAmount,
      sortBy,
      sortDir,
      limit,
      ...days
    }: TransactionsFindInput,
    now = new Date(),
  ): Promise<TransactionsFind> {
    const range = resolveTransactionsFindRange(days, now);
    const { from, to } = dayRangeInstants(range);
    const db = this.drizzle.db;
    const where = and(
      gte(tx.createdAt, from),
      lte(tx.createdAt, to),
      type?.length ? inArray(tx.type, type) : undefined,
      status?.length ? inArray(tx.status, status) : undefined,
      playerId
        ? inArray(
            tx.walletId,
            db
              .select({ walletId: wallet.id })
              .from(wallet)
              .innerJoin(player, eq(player.userId, wallet.userId))
              .where(eq(player.id, playerId)),
          )
        : undefined,
      currency ? eq(tx.currency, currency.toUpperCase()) : undefined,
      minAmount ? gte(tx.amount, minAmount) : undefined,
    );
    const direction = sql.raw(sortDir);
    const [rows, totals] = await Promise.all([
      db
        .select({
          transactionId: tx.id,
          playerId: player.id,
          type: tx.type,
          status: tx.status,
          amount: tx.amount,
          currency: tx.currency,
          rail: tx.rail,
          createdAt: tx.createdAt,
        })
        .from(tx)
        .innerJoin(wallet, eq(wallet.id, tx.walletId))
        .leftJoin(player, eq(player.userId, wallet.userId))
        .where(where)
        // The transaction id breaks ties, so equal figures always list in the same order.
        .orderBy(sql`${SORT_COLUMNS[sortBy]} ${direction}`, sql`${tx.id} ${direction}`)
        .limit(limit + 1),
      db.select({ total: count() }).from(tx).where(where),
    ]);
    return {
      from: range.dateFrom,
      to: range.dateTo,
      total: totals[0]?.total ?? 0,
      truncated: rows.length > limit,
      transactions: rows.slice(0, limit).map((row) => ({
        ...row,
        createdAt: row.createdAt.toISOString(),
      })),
    };
  }
}
