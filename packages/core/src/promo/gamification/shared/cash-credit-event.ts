import { eq } from 'drizzle-orm';
import { player } from '@openora/core/pam/schema/profile';
import type { Uuid } from '@openora/core/contracts';
import type { DrizzleTx, EventBus } from '@openora/core/server';

export type CashCredit = {
  userId: Uuid;
  amount: string;
  currency: string;
  /** Null on a replayed credit: nothing moved, and the first credit was already announced. */
  transactionId: string | null;
};

/**
 * Announces a gamification cash credit through the outbox, in the transaction that moved it, so the
 * balance event exists if and only if the credit committed.
 */
export async function announceCashCredit(
  tx: DrizzleTx,
  events: EventBus,
  { userId, amount, currency, transactionId }: CashCredit,
): Promise<void> {
  if (!transactionId) {
    return;
  }
  const [account] = await tx
    .select({ id: player.id })
    .from(player)
    .where(eq(player.userId, userId));
  await events.emitInTransaction(tx, 'wallet.balance.changed', {
    userId,
    playerId: account?.id ?? null,
    amount,
    currency,
    transactionId,
    type: 'cashback',
    direction: 'credit',
  });
}
