import {
  type EventBus,
  makeNotFoundError,
  makeConflictError,
  createDomainError,
  DrizzleService,
  findOneOrThrow,
  pageToOffset,
} from '@blurifycom/core/server';
import {
  type PaymentAdapter,
  type AdminUserDirectory,
  type PlatformConfig,
  type KycStatus,
  type WalletRail,
} from '@blurifycom/core/contracts';
import { eq, desc, sql, and, gte, lte, count, inArray } from 'drizzle-orm';
import { wallet, walletTransaction } from '../schema/index.js';
import type {
  TransactionResult,
  WithdrawalQueueItem,
  WithdrawalQueueFilter,
} from '../contract/index.js';

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

export const KycRequiredError = makeConflictError(
  'KycRequiredError',
  'KYC verification required before withdrawal',
);

const KYC_PASS_STATUSES: ReadonlySet<KycStatus> = new Set(['verified', 'manually_overridden']);

export const CurrencyMismatchError = createDomainError(
  'CurrencyMismatchError',
  (requested, walletCurrency) =>
    `Currency mismatch: requested ${requested}, wallet holds ${walletCurrency}`,
);

const CRYPTO_CURRENCIES = new Set(['BTC', 'ETH', 'USDT']);

function railFor(currency: string): WalletRail {
  return CRYPTO_CURRENCIES.has(currency.toUpperCase()) ? 'crypto' : 'fiat';
}

const LARGE_WITHDRAWAL_THRESHOLD = 5000;

const HIGH_FREQUENCY_WINDOW_MS = 24 * 60 * 60 * 1000;
const HIGH_FREQUENCY_MIN_COUNT = 3;

function providerNameFor(rail: WalletRail | null): string {
  return rail === 'crypto' ? 'fireblocks' : 'psp';
}

export class WalletService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly events: EventBus,
    private readonly payment: PaymentAdapter,
    private readonly directory?: AdminUserDirectory,
    private readonly platformConfig?: PlatformConfig,
  ) {}

  private async assertKycForWithdrawal(userId: string) {
    if (!this.platformConfig?.kyc?.gateWithdrawals) return;
    const [summary] = this.directory ? await this.directory.lookupPlayers([userId]) : [];
    const status = summary?.kycStatus ?? null;
    if (!status || !KYC_PASS_STATUSES.has(status)) {
      throw new KycRequiredError();
    }
  }

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
          rail: railFor(currency),
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

  async withdraw(
    userId: string,
    amount: number,
    currency: string,
    _provider?: string,
  ): Promise<TransactionResult> {
    await this.assertKycForWithdrawal(userId);

    const transactionId = await this.drizzle.db.transaction(async (txn) => {
      const current = findOneOrThrow(
        await txn.select().from(wallet).where(eq(wallet.userId, userId)).for('update'),
        new WalletNotFoundError(userId),
      );
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

  async listWithdrawals(filters: WithdrawalQueueFilter) {
    const db = this.drizzle.db;
    const { page, limit } = filters;

    const conditions = [eq(walletTransaction.type, 'withdrawal')];
    if (filters.status) conditions.push(eq(walletTransaction.status, filters.status));
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
    const pageRows = matching.slice(start, start + limit);

    const pageWalletIds = [...new Set(pageRows.map((r) => r.tx.walletId))];
    const frequentWalletIds = new Set<string>();
    if (pageWalletIds.length > 0) {
      const since = new Date(Date.now() - HIGH_FREQUENCY_WINDOW_MS);
      const counts = await db
        .select({ walletId: walletTransaction.walletId, n: count() })
        .from(walletTransaction)
        .where(
          and(
            eq(walletTransaction.type, 'withdrawal'),
            gte(walletTransaction.createdAt, since),
            inArray(walletTransaction.walletId, pageWalletIds),
          ),
        )
        .groupBy(walletTransaction.walletId);
      for (const row of counts) {
        if (Number(row.n) >= HIGH_FREQUENCY_MIN_COUNT) frequentWalletIds.add(row.walletId);
      }
    }

    const items: WithdrawalQueueItem[] = pageRows.map((r) => {
      const summary = byUserId.get(r.userId);
      const riskTags: string[] = [];
      if (Number(r.tx.amount) >= LARGE_WITHDRAWAL_THRESHOLD) riskTags.push('large_amount');
      if (frequentWalletIds.has(r.tx.walletId)) riskTags.push('high_frequency');
      return {
        transactionId: r.tx.id,
        userId: r.userId,
        username: summary?.username ?? '',
        amount: Number(r.tx.amount),
        currency: r.tx.currency,
        rail: r.tx.rail ?? null,
        status: r.tx.status,
        kycStatus: summary?.kycStatus ?? null,
        riskTags,
        requestedAt: r.tx.createdAt.toISOString(),
      };
    });

    return { items, total: matching.length, page, limit };
  }

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

    let result: Awaited<ReturnType<PaymentAdapter['processWithdrawal']>>;
    try {
      result = await this.payment.processWithdrawal(amount, tx.currency, {
        transactionId: tx.id,
        userId,
        rail: tx.rail,
        adminId,
      });
    } catch (err) {
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
      .set({
        status: 'completed',
        providerName: providerNameFor(tx.rail),
        providerRefId: result.externalId,
      })
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
