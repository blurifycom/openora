import { and, eq, sql } from 'drizzle-orm';
import type { BonusCompletion } from '@openora/core/contracts';
import { moneyCompare, moneyScaleBy, moneySubtract, type DrizzleTx } from '@openora/core/server';
import { promoGrant, promoGrantEntry, type PromoGrant } from '../schema/index.js';

const ZERO = '0';

/**
 * What a completing grant is allowed to turn into real money. Absent multiplier means uncapped;
 * otherwise the ceiling is that multiple of what was originally granted, truncating, so the cap
 * is never rounded in the player's favour.
 */
export function capConversion(
  balance: string,
  grantedAmount: string,
  maxWinMultiplier: string | null | undefined,
): string {
  if (maxWinMultiplier === null || maxWinMultiplier === undefined) {
    return balance;
  }
  const ceiling = moneyScaleBy(grantedAmount, maxWinMultiplier);
  return moneyCompare(balance, ceiling) < 0 ? balance : ceiling;
}

/**
 * Moves a grant the caller holds locked from `active` to `completed`: C leaves the grant as the
 * amount the caller credits to the real balance, A and B are released. Null when the grant is no
 * longer active, so a second completion of the same grant writes nothing.
 */
export async function completeGrant(
  tx: DrizzleTx,
  grant: PromoGrant,
): Promise<BonusCompletion | null> {
  // The cap bites here, at the single point where bonus funds become real money, rather than
  // on every win along the way: what the terms limit is the payout, and winnings that are
  // still bonus can still be lost back. Anything above it dies with the grant.
  const convertedAmount = capConversion(
    grant.bonusBalance,
    grant.grantedAmount,
    grant.terms.maxWinMultiplier,
  );
  const [closed] = await tx
    .update(promoGrant)
    .set({
      status: 'completed',
      bonusBalance: ZERO,
      unlinkedCash: ZERO,
      linkedCash: ZERO,
      closedAt: sql`now()`,
    })
    .where(and(eq(promoGrant.id, grant.id), eq(promoGrant.status, 'active')))
    .returning({ id: promoGrant.id });
  if (!closed) {
    return null;
  }

  const capped = moneySubtract(grant.bonusBalance, convertedAmount);
  await tx.insert(promoGrantEntry).values({
    grantId: grant.id,
    userId: grant.userId,
    currency: grant.currency,
    type: 'convert',
    bonusAmount: `-${convertedAmount}`,
    balanceAfter: capped,
  });
  // What the cap took has to leave the ledger too, or a grant's entries stop summing to the
  // balance they explain and the surplus looks like money still owed to the player.
  if (moneyCompare(capped, ZERO) > 0) {
    await tx.insert(promoGrantEntry).values({
      grantId: grant.id,
      userId: grant.userId,
      currency: grant.currency,
      type: 'forfeit',
      bonusAmount: `-${capped}`,
      balanceAfter: ZERO,
    });
  }
  return { grantId: grant.id, convertedAmount };
}
