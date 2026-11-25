import type { IdentityReader, Uuid } from '@openora/core/contracts';
import type { DrizzleTx, EventBus } from '@openora/core/server';

export type CashCredit = {
  userId: Uuid;
  amount: string;
  currency: string;
  /** Null on a replayed credit: nothing moved, and the first credit was already announced. */
  transactionId: string | null;
};

export type CashCreditAnnouncer = { events: EventBus; identity: IdentityReader };

/**
 * Announces gamification cash credits through the outbox, in the transaction that moved them, so
 * each balance event exists if and only if its credit committed. The player is resolved once for
 * the whole batch.
 */
export async function announceCashCredits(
  tx: DrizzleTx,
  { events, identity }: CashCreditAnnouncer,
  userId: Uuid,
  credits: readonly Omit<CashCredit, 'userId'>[],
): Promise<void> {
  if (credits.every((credit) => !credit.transactionId)) {
    return;
  }
  // Through IDENTITY_READER on the credit's transaction, as the wallet resolves its own events'
  // player id: the profile table is not the ledger's to read.
  const playerId = await identity.getPlayerIdByUserId(userId, tx);
  for (const { amount, currency, transactionId } of credits) {
    if (!transactionId) {
      continue;
    }
    await events.emitInTransaction(tx, 'wallet.balance.changed', {
      userId,
      playerId,
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
  announcer: CashCreditAnnouncer,
  { userId, ...credit }: CashCredit,
): Promise<void> => announceCashCredits(tx, announcer, userId, [credit]);
