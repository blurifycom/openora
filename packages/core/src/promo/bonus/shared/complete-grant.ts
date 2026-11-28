import { and, eq, inArray, sql } from 'drizzle-orm';
import type { BonusCompletion } from '@openora/core/contracts';
import { moneyCompare, moneyScaleBy, moneySubtract, type DrizzleTx } from '@openora/core/server';
import { promoGrant, promoGrantEntry, type PromoGrant } from '../schema/index.js';

const ZERO = '0';

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

export async function completeGrant(
  tx: DrizzleTx,
  grant: PromoGrant,
  { from = ['active'] }: { from?: readonly PromoGrant['status'][] } = {},
): Promise<BonusCompletion | null> {
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
    .where(and(eq(promoGrant.id, grant.id), inArray(promoGrant.status, [...from])))
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
