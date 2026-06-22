import type {
  WalletCommands,
  WalletDebitArgs,
  WalletDebitOutcome,
} from '@blurifycom/core/contracts';
import type { DrizzleDb } from '@blurifycom/core/server';
import { and, eq, sql } from 'drizzle-orm';
import { wallet } from '../schema/index.js';

// Default in-process WALLET_COMMANDS implementation. Operates on the caller's
// transaction handle, so a debit commits or rolls back together with the caller's
// other writes - the same atomicity the cross-module schema-write gave, now behind
// a port the wallet module owns. The `balance >= amount` guard in the UPDATE makes
// concurrent debits safe (a lost race updates zero rows and we report the shortfall).
export class WalletCommandsService implements WalletCommands {
  async debit(tx: unknown, { userId, amount }: WalletDebitArgs): Promise<WalletDebitOutcome> {
    const txn = tx as DrizzleDb;
    const [row] = await txn.select().from(wallet).where(eq(wallet.userId, userId));
    const available = row ? Number(row.balance) : 0;
    if (!row || available < amount) return { ok: false, available };

    await txn
      .update(wallet)
      .set({ balance: sql`${wallet.balance} - ${amount}` })
      .where(and(eq(wallet.id, row.id), sql`${wallet.balance} >= ${amount}`));

    return {
      ok: true,
      newBalance: Math.round((available - amount) * 100) / 100,
    };
  }
}
