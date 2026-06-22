import { type EventBus, makeNotFoundError, createDomainError } from '@blurifycom/core/server';
import { type PaymentAdapter } from '@blurifycom/core/contracts';
import { DrizzleService, findOneOrThrow } from '@blurifycom/core/server';
import { eq, desc, sql } from 'drizzle-orm';
import { wallet, walletTransaction } from '../schema/index.js';
import type { WalletBalance, WalletTransaction, TransactionResult } from '../schemas/index.js';

export const WalletNotFoundError = makeNotFoundError('Wallet');

export const InsufficientBalanceError = createDomainError(
  'InsufficientBalanceError',
  (available, requested) => `Insufficient balance: available ${available}, requested ${requested}`,
);

export class WalletService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly events: EventBus,
    private readonly payment: PaymentAdapter,
  ) {}

  async getBalance(userId: string): Promise<WalletBalance> {
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
          metadata: JSON.stringify({ provider, externalId: psp.externalId }),
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
    provider?: string,
  ): Promise<TransactionResult> {
    const db = this.drizzle.db;

    const walletRecord = findOneOrThrow(
      await db.select().from(wallet).where(eq(wallet.userId, userId)),
      new WalletNotFoundError(userId),
    );

    const currentBalance = Number(walletRecord.balance);
    if (currentBalance < amount) {
      throw new InsufficientBalanceError(currentBalance, amount);
    }

    const psp = await this.payment.processWithdrawal(amount, currency, { userId, provider });

    const transactionId = await this.drizzle.db.transaction(async (txn) => {
      // Re-read inside the transaction so concurrent withdrawals cannot double-spend.
      const current = findOneOrThrow(
        await txn.select().from(wallet).where(eq(wallet.userId, userId)),
        new WalletNotFoundError(userId),
      );
      if (Number(current.balance) < amount) {
        throw new InsufficientBalanceError(Number(current.balance), amount);
      }

      const [tx] = await txn
        .insert(walletTransaction)
        .values({
          walletId: current.id,
          type: 'withdrawal',
          amount: amount.toString(),
          currency,
          status: 'completed',
          metadata: JSON.stringify({ provider, externalId: psp.externalId }),
        })
        .returning();

      await txn
        .update(wallet)
        .set({ balance: sql`${wallet.balance} - ${amount}` })
        .where(eq(wallet.id, current.id));

      return tx!.id;
    });

    this.events.emit('wallet.withdrawal.completed', { userId, amount, currency, transactionId });

    return { transactionId, status: 'completed' };
  }

  async getTransactions(userId: string): Promise<WalletTransaction[]> {
    const db = this.drizzle.db;

    const [walletRecord] = await db.select().from(wallet).where(eq(wallet.userId, userId));
    if (!walletRecord) return [];

    const txs = await db
      .select()
      .from(walletTransaction)
      .where(eq(walletTransaction.walletId, walletRecord.id))
      .orderBy(desc(walletTransaction.createdAt))
      .limit(100);

    return txs.map((tx) => ({
      id: tx.id,
      type: tx.type as WalletTransaction['type'],
      amount: Number(tx.amount),
      currency: tx.currency,
      status: tx.status as WalletTransaction['status'],
      createdAt: tx.createdAt.toISOString(),
    }));
  }
}
