import { Injectable, Inject } from '@nestjs/common';
import { type EventBus, EVENT_BUS, createDomainError } from '@oss/core';
import { type PaymentAdapter, PAYMENT_ADAPTER } from '@oss/adapters';
import { DrizzleService } from '@oss/db';
import { eq, desc, sql } from 'drizzle-orm';
import { wallet, walletTransaction } from '../schema/index.js';
import type { WalletBalance, WalletTransaction, TransactionResult } from '../schemas/index.js';

export const WalletNotFoundError = createDomainError(
  'WalletNotFoundError',
  (userId) => `Wallet not found for user: ${userId}`,
);

export const InsufficientBalanceError = createDomainError(
  'InsufficientBalanceError',
  (available, requested) => `Insufficient balance: available ${available}, requested ${requested}`,
);

@Injectable()
export class WalletService {
  constructor(
    private readonly drizzle: DrizzleService,
    @Inject(EVENT_BUS) private readonly events: EventBus,
    @Inject(PAYMENT_ADAPTER) private readonly payment: PaymentAdapter,
  ) {}

  async getBalance(userId: string): Promise<WalletBalance> {
    const [record] = await this.drizzle.db
      .select()
      .from(wallet)
      .where(eq(wallet.userId, userId));

    if (!record) {
      return { balance: 0, currency: 'USD', tenantId: '' };
    }

    return {
      balance: Number(record.balance),
      currency: record.currency,
      tenantId: record.tenantId,
    };
  }

  async deposit(
    userId: string,
    amount: number,
    currency: string,
    provider?: string,
  ): Promise<TransactionResult> {
    const db = this.drizzle.db;

    let [walletRecord] = await db.select().from(wallet).where(eq(wallet.userId, userId));

    if (!walletRecord) {
      [walletRecord] = await db
        .insert(wallet)
        .values({
          userId,
          tenantId: '',
          balance: '0',
          currency,
        })
        .returning();
    }

    const psp = await this.payment.processDeposit(amount, currency, { userId, provider });

    const [tx] = await db
      .insert(walletTransaction)
      .values({
        walletId: walletRecord!.id,
        tenantId: walletRecord!.tenantId,
        type: 'deposit',
        amount: amount.toString(),
        currency,
        status: 'completed',
        metadata: JSON.stringify({ provider, externalId: psp.externalId }),
      })
      .returning();

    await db
      .update(wallet)
      .set({ balance: sql`${wallet.balance} + ${amount}` })
      .where(eq(wallet.id, walletRecord!.id));

    this.events.emit('wallet.deposit.completed', {
      userId,
      amount,
      currency,
      transactionId: tx!.id,
    });

    return { transactionId: tx!.id, status: 'completed' };
  }

  async withdraw(
    userId: string,
    amount: number,
    currency: string,
    provider?: string,
  ): Promise<TransactionResult> {
    const db = this.drizzle.db;

    const [walletRecord] = await db.select().from(wallet).where(eq(wallet.userId, userId));
    if (!walletRecord) throw new WalletNotFoundError(userId);

    const currentBalance = Number(walletRecord.balance);
    if (currentBalance < amount) {
      throw new InsufficientBalanceError(currentBalance, amount);
    }

    const psp = await this.payment.processWithdrawal(amount, currency, { userId, provider });

    const [tx] = await db
      .insert(walletTransaction)
      .values({
        walletId: walletRecord.id,
        tenantId: walletRecord.tenantId,
        type: 'withdrawal',
        amount: amount.toString(),
        currency,
        status: 'completed',
        metadata: JSON.stringify({ provider, externalId: psp.externalId }),
      })
      .returning();

    await db
      .update(wallet)
      .set({ balance: sql`${wallet.balance} - ${amount}` })
      .where(eq(wallet.id, walletRecord.id));

    this.events.emit('wallet.withdrawal.completed', {
      userId,
      amount,
      currency,
      transactionId: tx!.id,
    });

    return { transactionId: tx!.id, status: 'completed' };
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
