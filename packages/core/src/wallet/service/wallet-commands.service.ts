import type {
  WalletCommands,
  WalletDebitArgs,
  WalletDebitOutcome,
  WalletCreditArgs,
  WalletCreditOutcome,
  WalletTransactionType,
} from '@openora/core/contracts';
import type { DrizzleDb } from '@openora/core/server';
import { and, eq, gte, sql } from 'drizzle-orm';
import { wallet, walletTransaction } from '../schema/index.js';
import { railFor } from './wallet.service.js';

// Round a money amount to 2 decimal places, avoiding binary float drift on the running balance.
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// Default in-process WALLET_COMMANDS implementation. Operates on the caller's
// transaction handle, so a move commits or rolls back together with the caller's
// other writes - the same atomicity the cross-module schema-write gave, now behind
// a port the wallet module owns. Every move writes a `wallet_transaction` ledger row
// (status `completed`, internal settlement so no provider ref) so gameplay shows in
// transaction history. The `balance >= amount` guard in the UPDATE makes concurrent
// debits safe (a lost race updates zero rows and we report the shortfall).
export class WalletCommandsService implements WalletCommands {
  // Completed, internal-settlement ledger row (no provider ref) shared by every gameplay move.
  private writeLedgerRow(
    txn: DrizzleDb,
    row: { id: string; currency: string },
    type: WalletTransactionType,
    amount: number,
  ) {
    return txn.insert(walletTransaction).values({
      walletId: row.id,
      type,
      amount: amount.toString(),
      currency: row.currency,
      status: 'completed',
      rail: railFor(row.currency),
    });
  }

  async debit(tx: unknown, { userId, amount, type }: WalletDebitArgs): Promise<WalletDebitOutcome> {
    const txn = tx as DrizzleDb;

    // `loss` is informational (stake already left at bet time): 0-amount row, balance untouched. Every other debit is real money.
    if (type !== 'loss' && amount <= 0) {
      throw new Error(`wallet debit amount must be positive (got ${amount})`);
    }

    const [row] = await txn.select().from(wallet).where(eq(wallet.userId, userId));
    if (!row) return { ok: false, available: 0 };
    const available = Number(row.balance);

    if (type === 'loss') {
      await this.writeLedgerRow(txn, row, 'loss', 0);
      return { ok: true, newBalance: available };
    }

    const debited = await txn
      .update(wallet)
      .set({ balance: sql`${wallet.balance} - ${amount}` })
      .where(and(eq(wallet.id, row.id), gte(wallet.balance, amount.toString())))
      .returning({ id: wallet.id });
    if (debited.length !== 1) return { ok: false, available };

    await this.writeLedgerRow(txn, row, type, amount);

    return { ok: true, newBalance: round2(available - Number(amount)) };
  }

  async credit(
    tx: unknown,
    { userId, amount, type }: WalletCreditArgs,
  ): Promise<WalletCreditOutcome> {
    const txn = tx as DrizzleDb;

    if (amount <= 0) {
      throw new Error(`wallet credit amount must be positive (got ${amount})`);
    }

    const [row] = await txn.select().from(wallet).where(eq(wallet.userId, userId));
    // Fail closed: a credit never creates a wallet - a missing one is a caller bug.
    if (!row) return { ok: false, reason: 'wallet not found' };

    await txn
      .update(wallet)
      .set({ balance: sql`${wallet.balance} + ${amount}` })
      .where(eq(wallet.id, row.id));

    await this.writeLedgerRow(txn, row, type, Number(amount));

    return { ok: true, newBalance: round2(Number(row.balance) + Number(amount)) };
  }
}
