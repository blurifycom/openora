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
 * Announces gamification cash credits through the outbox, in the transaction that moved them, so
 * each balance event exists if and only if its credit committed. The player is resolved once for
 * the whole batch.
 */
export async function announceCashCredits(
  tx: DrizzleTx,
  events: EventBus,
  userId: Uuid,
  credits: readonly Omit<CashCredit, 'userId'>[],
): Promise<void> {
  if (credits.every((credit) => !credit.transactionId)) {
    return;
  }
  const [account] = await tx
    .select({ id: player.id })
    .from(player)
    .where(eq(player.userId, userId));
  for (const { amount, currency, transactionId } of credits) {
    if (!transactionId) {
      continue;
    }
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
}

export const announceCashCredit = (
  tx: DrizzleTx,
  events: EventBus,
  { userId, ...credit }: CashCredit,
): Promise<void> => announceCashCredits(tx, events, userId, [credit]);
