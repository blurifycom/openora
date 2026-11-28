import type { IdentityReader, Uuid } from '@openora/core/contracts';
import type { DrizzleTx, EventBus } from '@openora/core/server';

export type CashCredit = {
  userId: Uuid;
  amount: string;
  currency: string;
  transactionId: string | null;
};

export type CashCreditAnnouncer = { events: EventBus; identity: IdentityReader };

export async function announceCashCredits(
  tx: DrizzleTx,
  { events, identity }: CashCreditAnnouncer,
  userId: Uuid,
  credits: readonly Omit<CashCredit, 'userId'>[],
): Promise<void> {
  if (credits.every((credit) => !credit.transactionId)) {
    return;
  }
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
