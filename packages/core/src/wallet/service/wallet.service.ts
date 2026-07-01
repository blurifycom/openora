import {
  type EventBus,
  makeNotFoundError,
  makeConflictError,
  createDomainError,
  DrizzleService,
  findOneOrThrow,
  pageToOffset,
} from '@blurifycom/core/server';
import { type PaymentAdapter, type AdminUserDirectory } from '@blurifycom/core/contracts';
import { eq, desc, sql, and, gte, lte, count } from 'drizzle-orm';
import { wallet, walletTransaction } from '../schema/index.js';
import type {
  TransactionResult,
  WithdrawalQueueItem,
  WithdrawalQueueFilter,
  WalletRail,
} from '../schemas/index.js';

export const WalletNotFoundError = makeNotFoundError('Wallet');
export const WithdrawalNotFoundError = makeNotFoundError('Withdrawal');

export const InsufficientBalanceError = createDomainError(
  'InsufficientBalanceError',
  (available, requested) => `Insufficient balance: available ${available}, requested ${requested}`,
);

export const WithdrawalNotPendingError = makeConflictError(
  'WithdrawalNotPendingError',
  'Withdrawal is not pending and cannot be reviewed',
);

export const CurrencyMismatchError = createDomainError(
  'CurrencyMismatchError',
  (requested, walletCurrency) =>
    `Currency mismatch: requested ${requested}, wallet holds ${walletCurrency}`,
);

// Crypto currencies settle on the crypto rail (Fireblocks); everything else on the
// fiat rail (a PSP). The concrete provider is recorded per transaction, not here.
const CRYPTO_CURRENCIES = new Set(['BTC', 'ETH', 'USDT']);

function railFor(currency: string): WalletRail {
  return CRYPTO_CURRENCIES.has(currency.toUpperCase()) ? 'crypto' : 'fiat';
}

export class WalletService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly events: EventBus,
    private readonly payment: PaymentAdapter,
    private readonly directory?: AdminUserDirectory,
  ) {}

  async getBalance(userId: string) {
    const [record] = await this.drizzle.db.select().from(wallet).where(eq(wallet.userId, userId));

    if (!record) {
      return { balance: 0, currency: 'USD' };
    }

    return {
      balance: Number(record.balance),
      currency: record.currency,
    };
  }

  async deposit(
    userId: string,
    amount: number,
    currency: string,
    provider?: string,
  ): Promise<TransactionResult> {
    // PSP call stays outside the DB transaction; saga compensation for a PSP-success/ledger-failure split is out of scope.
    const psp = await this.payment.processDeposit(amount, currency, { userId, provider });

    const transactionId = await this.drizzle.db.transaction(async (txn) => {
      let [walletRecord] = await txn.select().from(wallet).where(eq(wallet.userId, userId));
      if (!walletRecord) {
        [walletRecord] = await txn
          .insert(wallet)
          .values({ userId, balance: '0', currency })
          .returning();
      }

      const [tx] = await txn
        .insert(walletTransaction)
        .values({
          walletId: walletRecord!.id,
          type: 'deposit',
          amount: amount.toString(),
          currency,
          status: 'completed',
          providerName: provider,
          providerRefId: psp.externalId,
        })
        .returning();

      await txn
        .update(wallet)
        .set({ balance: sql`${wallet.balance} + ${amount}` })
        .where(eq(wallet.id, walletRecord!.id));

      return tx!.id;
    });

    this.events.emit('wallet.deposit.completed', { userId, amount, currency, transactionId });

    return { transactionId, status: 'completed' };
  }

  /** Creates a PENDING withdrawal and HOLDS the funds (balance debited at request time). Funds are returned on reject/PSP-failure. */
  async withdraw(
    userId: string,
    amount: number,
    currency: string,
    _provider?: string,
  ): Promise<TransactionResult> {
    const transactionId = await this.drizzle.db.transaction(async (txn) => {
      // Lock the wallet row so two concurrent withdrawals serialize instead of both
      // reading the same balance and double-debiting (TOCTOU under READ COMMITTED).
      const current = findOneOrThrow(
        await txn.select().from(wallet).where(eq(wallet.userId, userId)).for('update'),
        new WalletNotFoundError(userId),
      );
      // The wallet is single-currency; a mismatched request would mislabel the row and
      // pick the wrong rail, so reject it rather than coerce. Compared case-insensitively
      // since railFor() normalizes case and 'usd'/'USD' are the same currency.
      if (currency.toUpperCase() !== current.currency.toUpperCase()) {
        throw new CurrencyMismatchError(currency, current.currency);
      }

      const [tx] = await txn
        .insert(walletTransaction)
        .values({
          walletId: current.id,
          type: 'withdrawal',
          amount: amount.toString(),
          currency,
          status: 'pending',
          rail: railFor(currency),
        })
        .returning();

      // Authoritative money-moving check: a guarded conditional debit. The WHERE clause
      // makes the balance>=amount test atomic with the write; 0 rows back means the hold
      // would overdraw, so the whole tx (incl. the inserted row) rolls back.
      const debited = await txn
        .update(wallet)
        .set({ balance: sql`${wallet.balance} - ${amount}` })
        .where(and(eq(wallet.id, current.id), gte(wallet.balance, amount.toString())))
        .returning({ id: wallet.id });
      if (debited.length !== 1) {
        throw new InsufficientBalanceError(Number(current.balance), amount);
      }

      return tx!.id;
    });

    this.events.emit('wallet.withdrawal.requested', { userId, amount, currency, transactionId });

    return { transactionId, status: 'pending' };
  }

  async listPendingWithdrawals(filters: WithdrawalQueueFilter) {
    const db = this.drizzle.db;
    const { page, limit } = filters;

    const conditions = [
      eq(walletTransaction.type, 'withdrawal'),
      eq(walletTransaction.status, 'pending'),
    ];
    if (filters.currency) conditions.push(eq(walletTransaction.currency, filters.currency));
    if (filters.rail) conditions.push(eq(walletTransaction.rail, filters.rail));
    if (filters.minAmount !== undefined) {
      conditions.push(gte(walletTransaction.amount, filters.minAmount.toString()));
    }
    if (filters.maxAmount !== undefined) {
      conditions.push(lte(walletTransaction.amount, filters.maxAmount.toString()));
    }
    if (filters.dateFrom) {
      conditions.push(gte(walletTransaction.createdAt, new Date(filters.dateFrom)));
    }
    if (filters.dateTo) {
      conditions.push(lte(walletTransaction.createdAt, new Date(filters.dateTo)));
    }

    // The pending-review queue is bounded (tens/hundreds), so we fetch every row matching
    // the wallet-side SQL filters, enrich + apply the kycStatus filter in memory, then
    // paginate - otherwise a DB-paginated fetch makes `total` wrong once kycStatus prunes.
    const rows = await db
      .select({ tx: walletTransaction, userId: wallet.userId })
      .from(walletTransaction)
      .innerJoin(wallet, eq(wallet.id, walletTransaction.walletId))
      .where(and(...conditions))
      .orderBy(desc(walletTransaction.createdAt));

    const userIds = [...new Set(rows.map((r) => r.userId))];
    const summaries = this.directory ? await this.directory.lookupPlayers(userIds) : [];
    const byUserId = new Map(summaries.map((s) => [s.userId, s]));

    const matching = filters.kycStatus
      ? rows.filter((r) => byUserId.get(r.userId)?.kycStatus === filters.kycStatus)
      : rows;

    const start = (page - 1) * limit;
    const items: WithdrawalQueueItem[] = matching.slice(start, start + limit).map((r) => {
      const summary = byUserId.get(r.userId);
      return {
        transactionId: r.tx.id,
        userId: r.userId,
        username: summary?.username ?? '',
        amount: Number(r.tx.amount),
        currency: r.tx.currency,
        rail: r.tx.rail ?? null,
        status: r.tx.status,
        kycStatus: summary?.kycStatus ?? null,
        riskTags: [],
        requestedAt: r.tx.createdAt.toISOString(),
      };
    });

    return { items, total: matching.length, page, limit };
  }

  /**
   * Approve: Pending -> Processing (commit + emit), send to PSP, then Completed on success
   * or Failed + refund on PSP error. Robust PSP idempotency-key/reconciliation for a
   * lost-response is deferred - same scope boundary the deposit path declares.
   */
  async approveWithdrawal(adminId: string, withdrawalId: string): Promise<TransactionResult> {
    const reviewedAt = new Date();

    const tx = await this.drizzle.db.transaction(async (txn) => {
      const current = findOneOrThrow(
        await txn
          .select()
          .from(walletTransaction)
          .where(eq(walletTransaction.id, withdrawalId))
          .for('update'),
        new WithdrawalNotFoundError(withdrawalId),
      );
      // Idempotency guard - only a pending withdrawal can be approved, so a concurrent
      // or repeated approve cannot double-send to the PSP.
      if (current.status !== 'pending' || current.type !== 'withdrawal') {
        throw new WithdrawalNotPendingError();
      }
      const [updated] = await txn
        .update(walletTransaction)
        .set({ status: 'processing', reviewedBy: adminId, reviewedAt })
        .where(eq(walletTransaction.id, withdrawalId))
        .returning();
      return updated!;
    });

    const userId = await this.userIdForWallet(tx.walletId);
    const amount = Number(tx.amount);
    this.events.emit('wallet.withdrawal.approved', {
      userId,
      amount,
      currency: tx.currency,
      transactionId: tx.id,
      adminId,
    });

    try {
      await this.payment.processWithdrawal(amount, tx.currency, {
        transactionId: tx.id,
        userId,
        rail: tx.rail,
        adminId,
      });
    } catch (err) {
      // Payout did not happen - mark failed and return the held funds in one transaction.
      await this.drizzle.db.transaction(async (txn) => {
        await txn
          .update(walletTransaction)
          .set({ status: 'failed' })
          .where(eq(walletTransaction.id, tx.id));
        await txn
          .update(wallet)
          .set({ balance: sql`${wallet.balance} + ${amount}` })
          .where(eq(wallet.id, tx.walletId));
      });
      this.events.emit('wallet.withdrawal.failed', {
        userId,
        amount,
        currency: tx.currency,
        transactionId: tx.id,
        adminId,
      });
      throw err;
    }

    await this.drizzle.db
      .update(walletTransaction)
      .set({ status: 'completed' })
      .where(eq(walletTransaction.id, tx.id));
    this.events.emit('wallet.withdrawal.completed', {
      userId,
      amount,
      currency: tx.currency,
      transactionId: tx.id,
    });

    return { transactionId: tx.id, status: 'completed' };
  }

  async rejectWithdrawal(
    adminId: string,
    withdrawalId: string,
    reason: string,
  ): Promise<TransactionResult> {
    const reviewedAt = new Date();

    const tx = await this.drizzle.db.transaction(async (txn) => {
      const current = findOneOrThrow(
        await txn
          .select()
          .from(walletTransaction)
          .where(eq(walletTransaction.id, withdrawalId))
          .for('update'),
        new WithdrawalNotFoundError(withdrawalId),
      );
      if (current.status !== 'pending' || current.type !== 'withdrawal') {
        throw new WithdrawalNotPendingError();
      }
      const [updated] = await txn
        .update(walletTransaction)
        .set({ status: 'rejected', reviewedBy: adminId, reviewedAt, reviewReason: reason })
        .where(eq(walletTransaction.id, withdrawalId))
        .returning();

      await txn
        .update(wallet)
        .set({ balance: sql`${wallet.balance} + ${updated!.amount}` })
        .where(eq(wallet.id, updated!.walletId));

      return updated!;
    });

    const userId = await this.userIdForWallet(tx.walletId);
    this.events.emit('wallet.withdrawal.rejected', {
      userId,
      amount: Number(tx.amount),
      currency: tx.currency,
      transactionId: tx.id,
      adminId,
      reason,
    });

    return { transactionId: tx.id, status: 'rejected' };
  }

  async getTransactions(userId: string, page: number, limit: number) {
    const db = this.drizzle.db;

    const [walletRecord] = await db.select().from(wallet).where(eq(wallet.userId, userId));
    if (!walletRecord) return { items: [], total: 0, page, limit };
    const where = eq(walletTransaction.walletId, walletRecord.id);
    const [txs, [{ n }]] = await Promise.all([
      db
        .select()
        .from(walletTransaction)
        .where(where)
        .orderBy(desc(walletTransaction.createdAt))
        .limit(limit)
        .offset(pageToOffset(page, limit)),
      db.select({ n: count() }).from(walletTransaction).where(where),
    ]);
    return {
      items: txs.map((tx) => ({
        id: tx.id,
        type: tx.type,
        amount: Number(tx.amount),
        currency: tx.currency,
        status: tx.status,
        createdAt: tx.createdAt.toISOString(),
      })),
      total: Number(n),
      page,
      limit,
    };
  }

  private async userIdForWallet(walletId: string) {
    const record = findOneOrThrow(
      await this.drizzle.db
        .select({ userId: wallet.userId })
        .from(wallet)
        .where(eq(wallet.id, walletId)),
      new WalletNotFoundError(walletId),
    );
    return record.userId;
  }
}
