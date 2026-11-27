import type { AdminTxListOptions, AdminWalletReporting } from '@openora/core/contracts';
import { DrizzleService, pageToOffset } from '@openora/core/server';
import { and, asc, between, count, desc, eq, gte, inArray, lte, or, sum } from 'drizzle-orm';
import { wallet, walletTransaction } from './schema/index.js';

const UUID_HEX_LENGTH = 32;
const HEX_PREFIX = /^[0-9a-f]+$/;

const toUuid = (hex: string) =>
  `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;

/**
 * An id prefix as the uuid range it covers, so the lookup rides the primary key instead of
 * casting every row's id to text. Null when the input cannot be the start of a uuid.
 */
export function uuidPrefixRange(search: string): { from: string; to: string } | null {
  const hex = search.toLowerCase().replaceAll('-', '');
  if (!HEX_PREFIX.test(hex) || hex.length > UUID_HEX_LENGTH) {
    return null;
  }
  return {
    from: toUuid(hex.padEnd(UUID_HEX_LENGTH, '0')),
    to: toUuid(hex.padEnd(UUID_HEX_LENGTH, 'f')),
  };
}

// Every branch is index-backed: the primary key, provider_ref_idx and tx_hash_idx.
function searchCondition(search: string) {
  const idRange = uuidPrefixRange(search);
  return or(
    idRange ? between(walletTransaction.id, idRange.from, idRange.to) : undefined,
    eq(walletTransaction.providerRefId, search),
    eq(walletTransaction.txHash, search),
  );
}

// See ADR-0017/0025.
export class DrizzleAdminWalletReporting implements AdminWalletReporting {
  constructor(private readonly drizzle: DrizzleService) {}

  async totals() {
    const db = this.drizzle.db;
    const [deposits, withdrawals] = await Promise.all([
      db
        .select({ total: sum(walletTransaction.amount) })
        .from(walletTransaction)
        .where(
          and(eq(walletTransaction.type, 'deposit'), eq(walletTransaction.status, 'completed')),
        )
        .then(([r]) => r?.total ?? '0'),
      db
        .select({ total: sum(walletTransaction.amount) })
        .from(walletTransaction)
        .where(
          and(eq(walletTransaction.type, 'withdrawal'), eq(walletTransaction.status, 'completed')),
        )
        .then(([r]) => r?.total ?? '0'),
    ]);
    return { deposits, withdrawals };
  }

  async listTransactions({
    page,
    limit,
    userIds,
    type,
    currency,
    rail,
    status,
    dateFrom,
    dateTo,
    amountMin,
    amountMax,
    search,
    sortBy,
    sortOrder,
  }: AdminTxListOptions) {
    const db = this.drizzle.db;
    const conditions = [
      userIds && userIds.length > 0 ? inArray(wallet.userId, userIds) : undefined,
      type ? eq(walletTransaction.type, type) : undefined,
      currency ? eq(walletTransaction.currency, currency) : undefined,
      rail ? eq(walletTransaction.rail, rail) : undefined,
      status ? eq(walletTransaction.status, status) : undefined,
      dateFrom ? gte(walletTransaction.createdAt, dateFrom) : undefined,
      dateTo ? lte(walletTransaction.createdAt, dateTo) : undefined,
      amountMin !== undefined ? gte(walletTransaction.amount, amountMin) : undefined,
      amountMax !== undefined ? lte(walletTransaction.amount, amountMax) : undefined,
      search ? searchCondition(search) : undefined,
    ].filter(Boolean);
    const where = conditions.length > 0 ? and(...conditions) : undefined;
    const [rows, [{ n }]] = await Promise.all([
      db
        .select({ tx: walletTransaction, walletUserId: wallet.userId })
        .from(walletTransaction)
        .innerJoin(wallet, eq(walletTransaction.walletId, wallet.id))
        .where(where)
        .orderBy(
          ((sortOrder ?? 'desc') === 'asc' ? asc : desc)(
            {
              createdAt: walletTransaction.createdAt,
              amount: walletTransaction.amount,
              type: walletTransaction.type,
              status: walletTransaction.status,
              currency: walletTransaction.currency,
              rail: walletTransaction.rail,
              reviewedAt: walletTransaction.reviewedAt,
            }[sortBy ?? 'createdAt'],
          ),
          desc(walletTransaction.id),
        )
        .limit(limit)
        .offset(pageToOffset(page, limit)),
      db
        .select({ n: count() })
        .from(walletTransaction)
        .innerJoin(wallet, eq(walletTransaction.walletId, wallet.id))
        .where(where),
    ]);
    return {
      rows: rows.map(({ tx, walletUserId }) => ({
        id: tx.id,
        userId: walletUserId,
        type: tx.type,
        amount: tx.amount,
        currency: tx.currency,
        status: tx.status,
        rail: tx.rail ?? null,
        createdAt: tx.createdAt,
      })),
      total: Number(n),
    };
  }

  async getTransaction(id: string) {
    const [row] = await this.drizzle.db
      .select({ tx: walletTransaction, walletUserId: wallet.userId })
      .from(walletTransaction)
      .innerJoin(wallet, eq(walletTransaction.walletId, wallet.id))
      .where(eq(walletTransaction.id, id));
    if (!row) {
      return null;
    }
    const { tx, walletUserId } = row;
    return {
      id: tx.id,
      userId: walletUserId,
      type: tx.type,
      amount: tx.amount,
      currency: tx.currency,
      status: tx.status,
      rail: tx.rail ?? null,
      createdAt: tx.createdAt,
      providerName: tx.providerName ?? null,
      providerRefId: tx.providerRefId ?? null,
      reviewedBy: tx.reviewedBy ?? null,
      reviewedAt: tx.reviewedAt ?? null,
      reviewReason: tx.reviewReason ?? null,
    };
  }
}
