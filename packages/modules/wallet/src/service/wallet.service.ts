import { Injectable, Inject } from '@nestjs/common';
import { type EventBus, EVENT_BUS } from '@oss/core';
import { PrismaService } from '@oss/persistence';
import type { WalletBalance, WalletTransaction, TransactionResult } from '../schemas/index.js';

export class WalletNotFoundError extends Error {
  constructor(userId: string) {
    super(`Wallet not found for user: ${userId}`);
    this.name = 'WalletNotFoundError';
  }
}

export class InsufficientBalanceError extends Error {
  constructor(available: number, requested: number) {
    super(`Insufficient balance: available ${available}, requested ${requested}`);
    this.name = 'InsufficientBalanceError';
  }
}

@Injectable()
export class WalletService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(EVENT_BUS) private readonly events: EventBus,
  ) {}

  async getBalance(userId: string): Promise<WalletBalance> {
    // oxlint-disable-next-line typescript/no-explicit-any
    const wallet = await (this.prisma as any).wallet.findUnique({
      where: { userId },
    });

    if (!wallet) {
      return { balance: 0, currency: 'USD', tenantId: '' };
    }

    return {
      balance: Number(wallet.balance),
      currency: wallet.currency as string,
      tenantId: wallet.tenantId as string,
    };
  }

  async deposit(
    userId: string,
    amount: number,
    currency: string,
    provider?: string,
  ): Promise<TransactionResult> {
    // oxlint-disable-next-line typescript/no-explicit-any
    const prisma = this.prisma as any;

    let wallet = await prisma.wallet.findUnique({ where: { userId } });

    if (!wallet) {
      wallet = await prisma.wallet.create({
        data: {
          userId,
          tenantId: '',
          balance: 0,
          currency,
        },
      });
    }

    const tx = await prisma.walletTransaction.create({
      data: {
        walletId: wallet.id,
        tenantId: wallet.tenantId,
        type: 'deposit',
        amount,
        currency,
        status: 'completed',
        metadata: provider ? { provider } : null,
      },
    });

    await prisma.wallet.update({
      where: { id: wallet.id },
      data: { balance: { increment: amount } },
    });

    this.events.emit('wallet.deposit.completed', {
      userId,
      amount,
      currency,
      transactionId: tx.id as string,
    });

    return { transactionId: tx.id as string, status: 'completed' };
  }

  async withdraw(
    userId: string,
    amount: number,
    currency: string,
    provider?: string,
  ): Promise<TransactionResult> {
    // oxlint-disable-next-line typescript/no-explicit-any
    const prisma = this.prisma as any;

    const wallet = await prisma.wallet.findUnique({ where: { userId } });
    if (!wallet) throw new WalletNotFoundError(userId);

    const currentBalance = Number(wallet.balance);
    if (currentBalance < amount) {
      throw new InsufficientBalanceError(currentBalance, amount);
    }

    const tx = await prisma.walletTransaction.create({
      data: {
        walletId: wallet.id,
        tenantId: wallet.tenantId,
        type: 'withdrawal',
        amount,
        currency,
        status: 'completed',
        metadata: provider ? { provider } : null,
      },
    });

    await prisma.wallet.update({
      where: { id: wallet.id },
      data: { balance: { decrement: amount } },
    });

    this.events.emit('wallet.withdrawal.completed', {
      userId,
      amount,
      currency,
      transactionId: tx.id as string,
    });

    return { transactionId: tx.id as string, status: 'completed' };
  }

  async getTransactions(userId: string): Promise<WalletTransaction[]> {
    // oxlint-disable-next-line typescript/no-explicit-any
    const prisma = this.prisma as any;

    const wallet = await prisma.wallet.findUnique({ where: { userId } });
    if (!wallet) return [];

    const txs = await prisma.walletTransaction.findMany({
      where: { walletId: wallet.id },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });

    return txs.map(
      (tx: {
        id: string;
        type: string;
        amount: unknown;
        currency: string;
        status: string;
        createdAt: Date;
      }) => ({
        id: tx.id,
        type: tx.type as WalletTransaction['type'],
        amount: Number(tx.amount),
        currency: tx.currency,
        status: tx.status as WalletTransaction['status'],
        createdAt: tx.createdAt.toISOString(),
      }),
    );
  }
}
